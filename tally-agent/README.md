# Kinematic Tally Connector

Bridge that runs on the PC where **Tally Prime** is open. It talks to Tally over its
local HTTP/XML port and to Kinematic over HTTPS (outbound only, nothing to open on the
firewall). It pushes invoices / payments / returns to Tally, reports a readiness
checklist, and pulls stock items and dealer ledgers for review in the dashboard.

## Install (about 3 minutes, Windows)

1. In the dashboard open **Distribution → Integrations**, create or open the Tally
   connection and click **Connect Tally PC**. You get a **Download** button and a
   6-character **pairing code** (e.g. `K7F-29X`, valid 24 h, single use).
2. On the Tally PC download `kinematic-tally-agent.exe`.
3. Open **Command Prompt as Administrator** in the download folder and run:

   ```
   kinematic-tally-agent.exe pair K7F-29X
   ```

   This saves the config to `C:\ProgramData\Kinematic\TallyConnector`, registers a
   startup task so it runs at boot, starts it, and reports to the dashboard.
4. In Tally: **F1 → Settings → Connectivity → Client/Server**, set *TallyPrime acts as*
   = **Both**, port **9000**, and keep the company open.
5. Back in the dashboard the **checklist** turns green. Anything missing is explained,
   and missing ledgers can be created from there.

Other commands: `check` (print what the connector sees in Tally), `run --once`,
`uninstall` (remove the startup task). Logs: `agent.log` next to `config.json`.

## Running from source instead of the .exe

Node 18+ is required: `node index.js pair K7F-29X`, then `node index.js run`
(`install` registers the Task Scheduler entry).

## Building the .exe

`.github/workflows/tally-agent-build.yml` (manual run, or push a tag `tally-agent-v*`)
tests and builds `kinematic-tally-agent.exe`. Host the file somewhere HTTPS-reachable
and set `TALLY_AGENT_DOWNLOAD_URL` on the API; the dashboard button goes through
`GET /api/v1/integrations/tally/agent/download`. Locally: `npm test`, `npm run build:exe`.
The .exe is unsigned, so Windows SmartScreen shows "unknown publisher" until it is
code-signed.

## Troubleshooting

**Cannot connect to Tally** - Tally is closed or its HTTP port is off (step 4).
**Pairing code invalid or expired** - generate a new one in the dashboard.
**`LINEERROR : Ledger '...' does not exist`** - use *Create missing ledgers* in the
checklist, or fix the ledger name in the integration settings (spaces and case matter).
**Dashboard says the connector was last seen long ago** - the PC is off or offline, or
the task stopped: `schtasks /Run /TN "Kinematic Tally Connector"`.

## What gets pushed to Tally

| Kinematic event | Tally voucher type | Notes |
|---|---|---|
| Invoice (status=issued) | Sales | Includes CGST/SGST/IGST/Cess as separate ledger entries; party is debited by the grand total. Round-off included if non-zero. |
| Payment (status=cleared) | Receipt | Bill allocations link the payment back to the original invoice (Agst Ref) so Tally's outstanding tracking stays correct. Cash mode debits Cash ledger; everything else debits Bank ledger. |
| Return (status=credited / supervisor_approved) | Credit Note | Sales returns ledger debited; party credited with the full amount. |

Inventory lines on sales vouchers and Sales Orders are not sent yet. The
ledgers above must exist in the Tally company; the dashboard checklist
finds the missing ones and can create them with one click.

## Privacy

The connector talks only to the Kinematic API (the URLs in `config.json`) and to your
local Tally. No telemetry. `config.json` holds the agent secret; the installer restricts
the folder to SYSTEM and Administrators.
