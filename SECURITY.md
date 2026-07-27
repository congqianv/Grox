# Security Policy

## Scope

This repository ships a Tauri desktop shell that launches a **system-installed**
Grok Build CLI and speaks ACP over stdio. Security issues may involve:

- the desktop shell (WebView, IPC, subprocess hosting, CSP, link handling)
- or the external Grok Build runtime (report to that project's maintainers)

## Reporting

For vulnerabilities in **this desktop shell**, open a private security report
through the repository host (for example GitHub Security Advisories) if available,
or contact the repository maintainers.

For vulnerabilities in **Grok Build / xAI products**, follow upstream guidance:

https://hackerone.com/x
