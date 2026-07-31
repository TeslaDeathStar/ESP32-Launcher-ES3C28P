#include "idf/launcher_platform.h"
#include "powerSave.h"
#include <M5Unified.h>
#include <Wire.h>
#include <interface.h>
#ifdef USE_CARDKB2
#include <cardkb2.h>
#endif

constexpr uint32_t kBtnBDoublePressWindowMs = 270;
constexpr uint32_t kBtnBLongPressMs = 500;

/***************************************************************************************
** Function name: _setup_gpio()
** Location: main.cpp
** Description:   initial setup for the device
***************************************************************************************/
void _setup_gpio() {
    M5.begin();
#ifndef USE_CARDKB2
    // Disable 5V output to external port. With CardKB2 support the rail must
    // stay on from M5.begin() so the keyboard's MCU is booted by probe time;
    // _post_setup_gpio() turns it off when no keyboard is found.
    M5.Power.setExtOutput(false);
#else
    M5.Power.setExtOutput(true); // CardKB2 needs Grove 5V
    delay(100);
#endif
    /*
  | Device  | SCK   | MISO  | MOSI  | CS    | GDO0/CE   |
  | ---     | :---: | :---: | :---: | :---: | :---:     |
  | SD Card | 5     | 4     | 6     | 7     | ---       |
  | CC1101  | 5     | 4     | 6     | 2     | 3         |
  | NRF24   | 5     | 4     | 6     | 8     | 1         |
  | PN532   | 5     | 4     | 6     | 43    | --        |
  | WS500   | 5     | 4     | 6     | **    | **        |
  | LoRa    | 5     | 4     | 6     | **    | **        |
      */
    launcherGpioOutput(7);
    launcherGpioWrite(7, HIGH); // SD Card CS
    launcherGpioOutput(2);
    launcherGpioWrite(2, HIGH); // CC1101 CS
    launcherGpioOutput(8);
    launcherGpioWrite(8, HIGH); // nRF24L01 CS
    launcherGpioOutput(43);
    launcherGpioWrite(43, HIGH); // PN532 CS
    launcherGpioOutput(9);
    launcherGpioWrite(9, LOW); // M5RF433 avoid Jamming
    launcherGpioOutput(46);
    launcherGpioWrite(46, LOW); // Infrared LED Off

    M5.BtnA.setDebounceThresh(8);
    M5.BtnB.setDebounceThresh(8);
    M5.BtnB.setHoldThresh(kBtnBLongPressMs);
}

/***************************************************************************************
** Function name: _post_setup_gpio()
** Location: main.cpp
** Description:   second stage gpio setup to make a few functions work
***************************************************************************************/
void _post_setup_gpio() {
#ifdef USE_CARDKB2
    // CardKB2 on the Grove port (G9/G10). Probing reconfigures G9 as I2C SDA,
    // so restore the RF433 anti-jam state if no keyboard is attached.
    if (!CardKB2Installed) {
        M5.Power.setExtOutput(false);
        launcherGpioOutput(9);
        launcherGpioWrite(9, LOW); // M5RF433 avoid Jamming
    }
#endif
}
/*********************************************************************
** Function: setBrightness
** location: settings.cpp
** set brightness value
**********************************************************************/
void _setBrightness(uint8_t brightval) { M5.Display.setBrightness(brightval); }

/***************************************************************************************
** Function name: getBattery()
** location: display.cpp
** Description:   Delivers the battery value from 1-100
***************************************************************************************/
int getBattery() {
    static int lastState = -1;
    bool charging = M5.Power.isCharging();
    if (charging && lastState != 1) {
        lastState = 1;
#ifdef USE_CARDKB2
        if (!CardKB2Installed) M5.Power.setExtOutput(false); // keyboard needs Grove 5V
#else
        M5.Power.setExtOutput(false);
#endif
    } else if (!charging && lastState != 0) {
        lastState = 0;
        M5.Power.setExtOutput(true);
    }
    int level = M5.Power.getBatteryLevel();
    return (level < 0) ? 0 : (level >= 100) ? 100 : level;
}

/*********************************************************************
** Function: InputHandler
** Handles the variables PrevPress, NextPress, SelPress, AnyKeyPress and EscPress
**********************************************************************/
void InputHandler(void) {
    static uint32_t btnBFirstReleaseMs = 0;
    static bool btnBWaitingSecondClick = false;
    static bool btnBLongPressFired = false;

    M5.update();
    bool emitNext = false;
    bool emitPrev = false;
    bool emitEsc = false;
    uint32_t now = launcherMillis();
    bool btnAActive = M5.BtnA.isPressed() || M5.BtnA.isHolding();
    bool btnBActive = M5.BtnB.isPressed() || M5.BtnB.isHolding();

    if (M5.BtnB.wasPressed()) btnBLongPressFired = false;

    if (btnBActive && !btnBLongPressFired && M5.BtnB.pressedFor(kBtnBLongPressMs)) {
        btnBLongPressFired = true;
        btnBWaitingSecondClick = false;
        emitEsc = true;
    }

    if (M5.BtnB.wasReleased()) {
        if (btnBLongPressFired) {
            btnBLongPressFired = false;
        } else if (btnBWaitingSecondClick && now - btnBFirstReleaseMs <= kBtnBDoublePressWindowMs) {
            btnBWaitingSecondClick = false;
            emitPrev = true;
        } else {
            btnBWaitingSecondClick = true;
            btnBFirstReleaseMs = now;
        }
    }

    if (btnBWaitingSecondClick && !btnBActive && now - btnBFirstReleaseMs > kBtnBDoublePressWindowMs) {
        btnBWaitingSecondClick = false;
        emitNext = true;
    }

    if (btnAActive || btnBActive || btnBWaitingSecondClick || M5.BtnA.wasClicked() || emitNext || emitPrev ||
        emitEsc)
        AnyKeyPress = true;
    if (!AnyKeyPress) return;

    if ((btnAActive || btnBActive) && wakeUpScreen()) return;

    if (M5.BtnA.wasClicked()) SelPress = true;
    if (emitNext) NextPress = true;
    if (emitPrev) PrevPress = true;
    if (emitEsc) EscPress = true;
}

/*********************************************************************
** Function: powerOff
** location: mykeyboard.cpp
** Turns off the device (or try to)
**********************************************************************/
void powerOff() { M5.Power.powerOff(); }
