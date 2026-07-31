#include "idf/launcher_platform.h"
#include "powerSave.h"
#include <Wire.h>
#include <interface.h>

#ifndef TFT_BRIGHT_CHANNEL
#define TFT_BRIGHT_CHANNEL 0
#define TFT_BRIGHT_FREQ 5000
#define TFT_BRIGHT_Bits 8
#endif

#ifndef TFT_BL
#define TFT_BL 45
#endif

#ifndef TOUCH_SDA
#define TOUCH_SDA 16
#endif
#ifndef TOUCH_SCL
#define TOUCH_SCL 15
#endif
#ifndef TOUCH_RST
#define TOUCH_RST 18
#endif
#ifndef TOUCH_INT
#define TOUCH_INT 17
#endif

#define FT6336_ADDR 0x38
#define FT6336_TD_STATUS 0x02
#define FT6336_T1_XH 0x03

static bool ft6336Read(uint8_t reg, uint8_t *buf, uint8_t len) {
    Wire.beginTransmission(FT6336_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;

    Wire.requestFrom((int)FT6336_ADDR, (int)len);
    for (uint8_t i = 0; i < len; i++) {
        buf[i] = Wire.available() ? Wire.read() : 0;
    }
    return true;
}

static bool ft6336ReadRaw(uint16_t *rawX, uint16_t *rawY) {
    uint8_t data[7];
    if (!ft6336Read(FT6336_TD_STATUS, data, sizeof(data))) return false;
    if ((data[0] & 0x0f) == 0) return false;

    *rawX = ((uint16_t)(data[1] & 0x0f) << 8) | data[2];
    *rawY = ((uint16_t)(data[3] & 0x0f) << 8) | data[4];
    return true;
}

static bool ft6336GetPoint(LTouchPoint *point) {
    uint16_t rawX;
    uint16_t rawY;
    if (!ft6336ReadRaw(&rawX, &rawY)) return false;

    switch (rotation % 4) {
        case 0:
            point->x = rawX;
            point->y = rawY;
            break;
        case 1:
            point->x = rawY;
            point->y = TFT_WIDTH - rawX;
            break;
        case 2:
            point->x = TFT_WIDTH - rawX;
            point->y = TFT_HEIGHT - rawY;
            break;
        case 3:
            point->x = TFT_HEIGHT - rawY;
            point->y = rawX;
            break;
    }

    point->pressed = true;
    return true;
}

static void ft6336Init() {
    pinMode(TOUCH_RST, OUTPUT);
    digitalWrite(TOUCH_RST, LOW);
    delay(10);
    digitalWrite(TOUCH_RST, HIGH);
    delay(300);

    Wire.begin(TOUCH_SDA, TOUCH_SCL, 400000U);

    uint8_t chipId = 0;
    Wire.beginTransmission(FT6336_ADDR);
    Wire.write(0xa3);
    if (Wire.endTransmission(false) == 0) {
        Wire.requestFrom((int)FT6336_ADDR, 1);
        if (Wire.available()) chipId = Wire.read();
    }
    launcherConsolePrintf("[ES3C28P] FT6336 chip ID: 0x%02X\n", chipId);
}

void _setup_gpio() {
    launcherGpioOutput(TFT_CS);
    launcherGpioWrite(TFT_CS, HIGH);
}

void _post_setup_gpio() {
    ft6336Init();

    pinMode(TFT_BL, OUTPUT);
    ledcAttach(TFT_BL, TFT_BRIGHT_FREQ, TFT_BRIGHT_Bits);
    ledcWrite(TFT_BL, bright);
}

void _setBrightness(uint8_t brightval) {
    int dutyCycle;
    if (brightval == 100) dutyCycle = 250;
    else if (brightval == 75) dutyCycle = 130;
    else if (brightval == 50) dutyCycle = 70;
    else if (brightval == 25) dutyCycle = 20;
    else if (brightval == 0) dutyCycle = 0;
    else dutyCycle = ((brightval * 250) / 100);

    launcherConsolePrintf("dutyCycle for bright 0-255: %d", dutyCycle);
    if (!ledcWrite(TFT_BL, dutyCycle)) {
        launcherConsolePrintf("%s\n", String("Failed to set brightness").c_str());
        ledcDetach(TFT_BL);
        ledcAttach(TFT_BL, TFT_BRIGHT_FREQ, TFT_BRIGHT_Bits);
        ledcWrite(TFT_BL, dutyCycle);
    }
}

void InputHandler(void) {
    static unsigned long tm = 0;
    if (launcherMillis() - tm > 200 || LongPress) {
        LTouchPoint point;
        if (ft6336GetPoint(&point)) {
            tm = launcherMillis();
            if (!wakeUpScreen()) AnyKeyPress = true;
            else return;

            launcherConsolePrintf(
                "\nTouch Pressed on x=%d, y=%d, rot: %d\n", point.x, point.y, rotation
            );
            touchPoint = point;
            touchHeatMap(touchPoint);
        } else {
            touchPoint.pressed = false;
        }
    }
}
