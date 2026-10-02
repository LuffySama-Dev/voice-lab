"""User-run private setup. No network calls, key lookup, or voice creation."""
import getpass
import os
from pathlib import Path
import re
import sys


def main():
    if not sys.stdin.isatty():
        raise ValueError("Run this yourself in a local terminal; secret entry requires a TTY.")
    destination = Path(__file__).resolve().parent.parent / ".env.voice"
    if destination.exists():
        raise ValueError(".env.voice already exists. Edit it privately in your local editor; no file was read or changed.")
    print("Eleven v4 Turbo setup. Use an existing authorized voice ID and a key with Text to Speech permission.")
    print("This saves credentials only in this project's ignored .env.voice (owner read/write). No API call is made.")
    print("When you later launch voice:background and start a consented session, reply text goes to ElevenLabs and uses paid credits.")
    voice = input("Authorized existing voice ID: ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", voice):
        raise ValueError("Invalid voice ID; no file was written.")
    if input("Type ENABLE to enable paid speech for your later user-started sessions: ").strip() != "ENABLE":
        print("Cancelled. No file was written.")
        return
    key = getpass.getpass("ElevenLabs API key (hidden): ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,512}", key):
        raise ValueError("Invalid key format; no file was written.")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write("# Private local voice setup; never share or commit.\n")
        file.write(f"ELEVENLABS_API_KEY={key}\nELEVENLABS_VOICE_ID={voice}\nELEVEN_TTS_ENABLED=1\n")
    print("Saved privately. No service contacted. Next: npm run build && npm run voice:background")
    print("Then open http://localhost:4319/?mode=codex&voice=1. Stop the existing Codex server only when its microphone session is idle before relaunching on port 4319.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled. No credentials were displayed.")
        sys.exit(1)
    except (ValueError, OSError) as error:
        # OSError paths can be shown; credential values are never part of an operation's error.
        print(str(error) if isinstance(error, ValueError) else "Could not create the private setup file. No existing file was overwritten.", file=sys.stderr)
        sys.exit(1)
