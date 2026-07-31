#ifndef Pins_Arduino_h
#define Pins_Arduino_h

#include "soc/soc_caps.h"
#include <stdint.h>

#define USB_VID 0x303A
#define USB_PID 0x1001

static const uint8_t TX = 43;
static const uint8_t RX = 44;

static const uint8_t SDA = 1;
static const uint8_t SCL = 2;

static const uint8_t SS = 10;
static const uint8_t MOSI = 11;
static const uint8_t MISO = 12;
static const uint8_t SCK = 13;

static const uint8_t G0 = 0;
static const uint8_t G1 = 1;
static const uint8_t G2 = 2;
static const uint8_t G3 = 3;
static const uint8_t G4 = 4;
static const uint8_t G5 = 5;
static const uint8_t G6 = 6;
static const uint8_t G7 = 7;
static const uint8_t G8 = 8;
static const uint8_t G9 = 9;
static const uint8_t G10 = 10;
static const uint8_t G11 = 11;
static const uint8_t G12 = 12;
static const uint8_t G13 = 13;
static const uint8_t G14 = 14;
static const uint8_t G15 = 15;
static const uint8_t G39 = 39;
static const uint8_t G40 = 40;
static const uint8_t G41 = 41;
static const uint8_t G42 = 42;
static const uint8_t G43 = 43;
static const uint8_t G44 = 44;
static const uint8_t G45 = 45;
static const uint8_t G48 = 48;

#define GROVE_SDA 1
#define GROVE_SCL 2

#define RGB_LED 38

#define HAS_SCREEN 1
#define FP 1
#define FM 2
#define FG 3
#define ROTATION 1
#define MINBRIGHT 1

#define ST7789_DRIVER 1
#define TFT_WIDTH 172
#define TFT_HEIGHT 320
#define TFT_BACKLIGHT_ON HIGH
#define TFT_BL 48
#define TFT_RST 39
#define TFT_DC 41
#define TFT_MOSI 45
#define TFT_SCLK 40
#define TFT_CS 42

#define PIN_SD_CLK 14
#define PIN_SD_CMD 15
#define PIN_SD_D0 16
#define SDM SD_MMC
#define SDCARD_CS -1
#define SDCARD_SCK PIN_SD_CLK
#define SDCARD_MISO PIN_SD_D0
#define SDCARD_MOSI PIN_SD_CMD

#endif /* Pins_Arduino_h */
