# StudyFlow

StudyFlow is a local-first Windows desktop companion for Canvas. It mirrors the courses and materials you select, keeps a local library in `Documents\\StudyFlow`, and creates reviewable assignment workspaces. It never submits work to Canvas.

## Install

Download `StudyFlow-Desktop-Setup-*.exe` from the [latest GitHub Release](https://github.com/Hola3Dprint/StudyFlow/releases/latest), run it, and choose an installation location. The installer creates Start Menu and desktop shortcuts.

The installed app checks GitHub Releases in the background. When a later version is available, it downloads it and offers to restart; otherwise it installs automatically when StudyFlow closes.

## First use

1. Open **Settings** and enter your school’s HTTPS Canvas URL and personal access token.
2. Choose **Add key & sync courses**, then select the courses and materials you want stored locally.
3. Review an assignment and start an AI workspace only when you are ready.

Canvas access is read-only. Canvas tokens and Apple Calendar credentials are encrypted with Windows DPAPI and remain on the local PC. StudyFlow does not accept raw OpenAI API keys.

## License

StudyFlow is source-available under the [PolyForm Noncommercial 1.0.0](LICENSE) license. Personal, educational, research, and other noncommercial use is permitted. Commercial use, resale, or use in a commercial product requires a separate written license from the copyright owner.
