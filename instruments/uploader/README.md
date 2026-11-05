# Binary instrument uploader

The uploader runs on an instrument PC. It watches the folders where the instrument saves its files and sends each new or changed file to your lab in Binary. Files show up under Instruments, in a folder named after the instrument.

## What it does and doesn't do

- It only reads the files. It never deletes, renames, moves or edits anything in the folders it watches.
- It sends a file once the file has stopped changing for 10 seconds and no other program is still writing it.
- It sends the files in parts. If the PC restarts or the network drops, it picks up where it stopped.
- It skips files the lab already has, so a copy of the same file isn't sent twice.
- It skips temporary and hidden files. See [When a file doesn't show up](#when-a-file-doesnt-show-up).
- It can only add files to this one instrument in your lab. It can't read anything from Binary.

## Set it up

You need a Windows user account on the instrument PC that stays logged in while the instrument is used. Do every step below as that user.

1. Get `binary-labs-uploader.exe` from Binary. Each build of the uploader produces it as the `binary-labs-uploader-windows-x64` download.
2. Make a folder `C:\Program Files\Binary\` and put the `.exe` in it.
3. In Binary, go to Settings > Instruments and click Add an instrument. Give it a name people will recognize, like "Plate reader, room 214". You get a pairing code.
4. Open Command Prompt and pair the PC within 15 minutes. Use your lab's Binary address and the code.

   ```
   "C:\Program Files\Binary\binary-labs-uploader.exe" pair https://app.binarylabs.example K7QM-4XPA
   ```

   It prints the instrument and lab name. A code works only once. If it has expired, add the instrument again to get a new one.

5. Add the folder the instrument saves its files to. Files in folders inside it are sent too.

   ```
   "C:\Program Files\Binary\binary-labs-uploader.exe" add-folder "D:\Instrument data\Exports"
   ```

   The folder's own name becomes the first part of each file's path in Binary. Here a file `D:\Instrument data\Exports\P450\plate07.csv` shows up as `Exports/P450/plate07.csv`. You can add more folders, but not two with the same name.

6. Check the setup.

   ```
   "C:\Program Files\Binary\binary-labs-uploader.exe" status
   ```

## Start it with Windows

The uploader runs from Task Scheduler. It starts when you log on, as you. Run this in Command Prompt. If it says access is denied, open Command Prompt with Run as administrator, still as the same user.

```
schtasks /Create /TN "Binary uploader" /TR "\"C:\Program Files\Binary\binary-labs-uploader.exe\" run" /SC ONLOGON /RL LIMITED /F
```

Task Scheduler stops a task after 3 days by default. Turn that off once.

1. Open Task Scheduler and find Binary uploader in Task Scheduler Library.
2. Open it. On the Settings tab, clear "Stop the task if it runs longer than".
3. On the Conditions tab, clear "Start the task only if the computer is on AC power".
4. Click OK.

To start it now without logging off, run `schtasks /Run /TN "Binary uploader"`.

A Command Prompt window opens with the uploader in it. Minimize it. Closing it stops the uploads until the next log on.

The uploader runs as a scheduled task, not as a Windows service. It keeps running through network and server errors, so it doesn't need a service to restart it. It also runs as the user who paired it, so it finds that user's settings and pairing token.

## How to tell it's working

- In Binary, Settings > Instruments shows when the uploader was last seen and how many files it has sent. It checks in every minute.
- `status` shows the watched folders, the files waiting to be sent, the files sent so far, the last sync and the last error. It works while the uploader is running.
- The log is in `%LOCALAPPDATA%\Binary\uploader\logs`, one file per day. The last 14 days are kept.

## When a file doesn't show up

- A file is sent once it has been still for 10 seconds. A file the instrument is still writing waits until the instrument closes it.
- These files are skipped:
  - names starting with `~$` or `.`
  - names ending in `.tmp` or `.lock`
  - `Thumbs.db` and `desktop.ini`
  - hidden and system files, and anything in a hidden or system folder
- Files over the lab's size limit (500 MB) are skipped until they change. `status` lists them under "Too large to send".
- If Binary can't be reached, the uploader keeps trying. It waits a little longer after each failed try, up to 5 minutes. `status` shows what it's waiting on.
- If `status` or the window says "This uploader isn't paired any more", the instrument was removed or its pairing was revoked. Add the instrument again in Settings > Instruments and run `pair` with the new code. Your folders are kept. If it's paired as a new instrument, its files are sent again under the new name.
- A folder added while the uploader runs is picked up within a minute.

## Settings and privacy

The settings, the upload queue and the logs are in `%LOCALAPPDATA%\Binary\uploader`. The settings hold the pairing token. Windows lets only your user account and administrators open that folder. The token is never printed or written to the log.

To keep the settings somewhere else, add `--config-dir <folder>` to every command, or set the `BINARY_LABS_UPLOADER_DIR` environment variable.

## Remove it

1. In Binary, go to Settings > Instruments and revoke the instrument. The uploader stops the next time it checks in, within a minute.
2. Delete the task.

   ```
   schtasks /Delete /TN "Binary uploader" /F
   ```

3. Delete the folder `%LOCALAPPDATA%\Binary\uploader` and `C:\Program Files\Binary\`.

Files already sent stay in Binary. The files on the instrument PC are never touched.

## For developers

The uploader is one Rust binary. Build and test it with `cargo test` and `cargo build --release` in this folder. CI builds the Windows `.exe` on a GitHub Actions Windows runner (`.github/workflows/uploader.yml`).
