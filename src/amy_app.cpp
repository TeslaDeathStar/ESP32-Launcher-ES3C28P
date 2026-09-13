#include "amy_app.h"

#include "display.h"
#include "idf/idf_http_client.h"
#include "idf/idf_wifi.h"
#include "idf/launcher_platform.h"
#include "mykeyboard.h"
#include "onlineLauncher.h"
#include "settings.h"
#include <ArduinoJson.h>
#include <Preferences.h>
#include <vector>

#include <globals.h>

#ifndef HEADLESS
namespace {

constexpr const char *kDefaultGateway = "http://10.0.2.218:8788";
constexpr const char *kAmyNamespace = "amy_app";

struct AmyConfig {
    String gateway;
    String token;
};

AmyConfig loadConfig() {
    Preferences preferences;
    AmyConfig config;
    config.gateway = kDefaultGateway;
    if (preferences.begin(kAmyNamespace, true)) {
        String storedGateway = preferences.getString("gateway", "");
        String storedToken = preferences.getString("token", "");
        preferences.end();
        if (!storedGateway.isEmpty()) config.gateway = storedGateway;
        config.token = storedToken;
    }
    config.gateway.trim();
    while (config.gateway.endsWith("/")) config.gateway.remove(config.gateway.length() - 1);
    return config;
}

void saveConfig(const AmyConfig &config) {
    Preferences preferences;
    if (!preferences.begin(kAmyNamespace, false)) return;
    preferences.putString("gateway", config.gateway);
    preferences.putString("token", config.token);
    preferences.end();
}

void wrapText(const String &text, int maxChars, std::vector<String> &lines) {
    lines.clear();
    String line;
    String word;
    auto appendWord = [&]() {
        if (word.isEmpty()) return;
        while (static_cast<int>(word.length()) > maxChars) {
            if (!line.isEmpty()) {
                lines.push_back(line);
                line = "";
            }
            lines.push_back(word.substring(0, maxChars));
            word = word.substring(maxChars);
        }
        const int extra = line.isEmpty() ? 0 : 1;
        if (!line.isEmpty() && static_cast<int>(line.length()) + extra + word.length() > maxChars) {
            lines.push_back(line);
            line = "";
        }
        if (!line.isEmpty()) line += " ";
        line += word;
        word = "";
    };

    for (size_t i = 0; i < text.length(); ++i) {
        const char c = text[i];
        if (c == '\n') {
            appendWord();
            lines.push_back(line);
            line = "";
        } else if (c == ' ') {
            appendWord();
        } else {
            word += c;
        }
    }
    appendWord();
    if (!line.isEmpty() || lines.empty()) lines.push_back(line);
}

void waitForAmyInput() {
    resetGlobals();
    while (!AnyKeyPress && !touchPoint.pressed) {
        InputHandler();
        launcherDelayMs(10);
    }
    resetGlobals();
}

void drawAmyMessage(const String &userText, const String &reply, const String &status) {
    tft->fillScreen(BGCOLOR);
    tft->setTextSize(FM);
    tft->setTextColor(ALCOLOR, BGCOLOR);
    tft->drawString("Morning Star / Amy", 8, 8);
    tft->setTextSize(FP);
    tft->setTextColor(FGCOLOR, BGCOLOR);
    tft->drawRightString(status, tftWidth - 8, 10, 1);
    tft->drawLine(8, 26, tftWidth - 8, 26, ALCOLOR);

    const int maxChars = max(12, (static_cast<int>(tftWidth) - 24) / (LW * FP));
    std::vector<String> lines;
    int y = 34;
    if (!userText.isEmpty()) {
        tft->setTextColor(ALCOLOR, BGCOLOR);
        tft->setTextSize(FP);
        tft->drawString("You", 8, y);
        y += LH * FP + 2;
        wrapText(userText, maxChars, lines);
        tft->setTextColor(FGCOLOR, BGCOLOR);
        for (const String &line : lines) {
            if (y > static_cast<int>(tftHeight) - 50) break;
            tft->drawString(line, 8, y);
            y += LH * FP;
        }
        y += 4;
    }

    tft->setTextColor(ALCOLOR, BGCOLOR);
    tft->setTextSize(FP);
    tft->drawString("Amy", 8, y);
    y += LH * FP + 2;
    wrapText(reply, maxChars, lines);
    tft->setTextColor(FGCOLOR, BGCOLOR);
    for (const String &line : lines) {
        if (y > static_cast<int>(tftHeight) - 50) break;
        tft->drawString(line, 8, y);
        y += LH * FP;
    }

    tft->setTextColor(ALCOLOR, BGCOLOR);
    tft->drawString("Touch or press Select to return", 8, tftHeight - 24);
    tft->display(false);
    waitForAmyInput();
}

void showConfig(const AmyConfig &config) {
    String text = String("Gateway: ") + config.gateway + "\n";
    text += config.token.isEmpty() ? "Device token: not set" : "Device token: set";
    drawAmyMessage("", text, "Connection");
}

void configureAmy(AmyConfig &config) {
    String gateway = keyboard(config.gateway, 127, "Amy gateway URL:");
    if (gateway == String(KEY_ESCAPE)) return;
    gateway.trim();
    if (gateway.isEmpty()) return;
    String token = keyboard(config.token, 127, "Device token (optional):");
    if (token == String(KEY_ESCAPE)) return;
    token.trim();
    config.gateway = gateway;
    while (config.gateway.endsWith("/")) config.gateway.remove(config.gateway.length() - 1);
    config.token = token;
    saveConfig(config);
    showConfig(config);
}

void askAmy(const AmyConfig &config, String &lastUser, String &lastReply) {
    if (!launcherWifiIsConnected() && !connectWifi()) {
        drawAmyMessage("", "Wi-Fi is not connected. Use Connection or Launcher Wi-Fi settings first.", "Offline");
        return;
    }

    String prompt = keyboard("", 160, "Ask Amy:");
    if (prompt == String(KEY_ESCAPE)) return;
    prompt.trim();
    if (prompt.isEmpty()) return;

    JsonDocument request;
    request["message"] = prompt;
    String body;
    serializeJson(request, body);

    String endpoint = config.gateway + "/api/device/chat";
    String responseBody;
    LauncherHttpResponse response;
    const char *headerKey = config.token.isEmpty() ? nullptr : "X-Amy-Device-Token";
    const char *headerValue = config.token.isEmpty() ? nullptr : config.token.c_str();
    bool ok = launcherHttpPost(
        endpoint.c_str(), body.c_str(), body.length(), responseBody, 12000, &response, headerKey, headerValue
    );
    if (!ok) {
        String error = String("Gateway error ") + response.status;
        if (!responseBody.isEmpty()) {
            JsonDocument errorDoc;
            if (deserializeJson(errorDoc, responseBody) == DeserializationError::Ok) {
                const char *detail = errorDoc["error"] | "";
                if (detail[0]) error += String(": ") + detail;
            }
        }
        drawAmyMessage(prompt, error, "Error");
        return;
    }

    JsonDocument replyDoc;
    if (deserializeJson(replyDoc, responseBody) != DeserializationError::Ok) {
        drawAmyMessage(prompt, "Amy returned an unreadable response.", "Error");
        return;
    }
    String reply = replyDoc["reply"].as<String>();
    if (reply.isEmpty()) reply = "Amy returned no text.";
    lastUser = prompt;
    lastReply = reply;
    drawAmyMessage(lastUser, lastReply, "Gemini text");
}

} // namespace

void loopAmy() {
    AmyConfig config = loadConfig();
    String lastUser;
    String lastReply = "Ready. This companion has no Home Assistant, terminal, or file controls.";
    returnToMenu = false;

    while (!returnToMenu) {
        std::vector<Option> actions = {
            {"Ask Amy", [&]() { askAmy(config, lastUser, lastReply); }},
            {"Connection", [&]() { configureAmy(config); }},
            {"Back", [&]() { returnToMenu = true; }},
        };
        if (loopOptions(actions, false, FGCOLOR, BGCOLOR, true) < 0) returnToMenu = true;
    }
    tft->fillScreen(BGCOLOR);
    resetGlobals();
}

#else

void loopAmy() {}

#endif
