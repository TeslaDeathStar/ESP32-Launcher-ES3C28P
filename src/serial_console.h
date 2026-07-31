#ifndef LAUNCHER_SERIAL_CONSOLE_H
#define LAUNCHER_SERIAL_CONSOLE_H

// FreeRTOS task that parses commands typed into the Serial Monitor and lets a
// host script drive the Launcher (navigate menus, inspect/edit the partition
// table, flash firmware) without physical button access. See src/serial_console.cpp
// for the command grammar.
void taskSerialConsole(void *parameter);

#endif
