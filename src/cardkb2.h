#ifndef __CARDKB2_H
#define __CARDKB2_H
#ifdef USE_CARDKB2

// M5Stack CardKB2 (U215) on the Grove port, default I2C mode.
// Probed once at boot; the keyboard must be attached before power-on.

extern bool CardKB2Installed;
// While true (text-entry screens), printable keys feed KeyStroke only and
// navigation flags are left untouched, so typing does not move the cursor.
extern volatile bool CardKB2TextMode;

// Probes the Grove port for a CardKB2. Returns true when found.
bool cardkb2_setup(int I2C_SDA, int I2C_SCL);
// Drains pending keys and updates the global input state. Cheap no-op when
// no keyboard was detected. Call from the board's InputHandler().
void cardkb2_poll();

#endif // USE_CARDKB2
#endif // __CARDKB2_H
