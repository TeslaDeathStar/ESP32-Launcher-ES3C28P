import os

Import("env")   # type: ignore

def before_upload(source, target, env):
    env.Replace(ESP32_APP_OFFSET="0x10000")

env.AddPreAction("upload", before_upload)
