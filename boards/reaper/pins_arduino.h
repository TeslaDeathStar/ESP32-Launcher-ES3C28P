#ifndef Pins_Arduino_h
#define Pins_Arduino_h

#include "soc/soc_caps.h"
#include <stdint.h>

// SERIAL
#define SERIAL_TX 43
#define SERIAL_RX 44
static const uint8_t TX = SERIAL_TX;
static const uint8_t RX = SERIAL_RX;
#define TX1 TX
#define RX1 RX

static const uint8_t SDA = 47;
static const uint8_t SCL = 48;

static const uint8_t SS = 11;
static const uint8_t MOSI = 18;
static const uint8_t MISO = 8;
static const uint8_t SCK = 17;

#endif /* Pins_Arduino_h */
