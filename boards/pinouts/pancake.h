#ifndef Pins_Arduino_h
#define Pins_Arduino_h

#include <stdint.h>

// H4W9 Pancake — ESP32-C5-WROOM-1U
// Confirmed pin map (voltmeter + scope, 2026):

static const uint8_t LED_BUILTIN = 27; // NeoPixel (WS2812B)
#define BUILTIN_LED LED_BUILTIN
#define LED_BUILTIN LED_BUILTIN

// LP UART — fixed on ESP32-C5
static const uint8_t LP_RX = 12;
static const uint8_t LP_TX = 11;

static const uint8_t USB_DM = 13;
static const uint8_t USB_DP = 14;

// UART for GPS (Serial1)
static const uint8_t TX = 14; // GPS_TX
static const uint8_t RX = 13; // GPS_RX

// I2C — shared by FT6336 cap touch and MAX17048 fuel gauge
static const uint8_t SDA = 9;
static const uint8_t SCL = 10;

// SPI bus — shared by TFT (ST7796), SD card
//   TFT CS  = GPIO5
//   SD CS   = GPIO7
static const uint8_t SS   = 7;  // SD card CS (primary SS)
static const uint8_t MOSI = 24;
static const uint8_t MISO = 4;
static const uint8_t SCK  = 23;

#endif /* Pins_Arduino_h */
