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

| Kinematic event | Tally object | Notes |
|---|---|---|
| Invoice (status=issued) | Sales voucher | GST as separate ledger entries; round-off included. **Item invoice** (stock items, quantities, rates) when every line is linked to a Tally stock item through *Pull from Tally* and the lines add up to the invoice; otherwise the same ledger-only voucher as before. |
| Payment (status=cleared) | Receipt voucher | Bill allocations link it to the invoice (Agst Ref). Cash debits the Cash ledger, everything else the Bank ledger. |
| Return (credited / approved) | Credit Note | Sales-returns ledger debited; party credited. |
| Approved order *(opt-in: `sync_orders`)* | Sales Order | Items and order due date; no taxes (they belong on the invoice). Refused with a clear message if a line's product is not linked. Orders are not auto-closed by the later invoice. |
| New dealer *(opt-in: `auto_create_ledgers`)* | Sundry Debtor ledger | GSTIN, state, address, credit limit and period. Dealers already linked to a Tally ledger are skipped. |
| New product *(opt-in: `auto_create_stock_items`)* | Stock item (+ unit) | No stock group is set, so a missing group cannot fail the import. |

The three opt-in switches live in the integration's `config` and are toggled in the dashboard under
**Set up & sync → Automatic sending**. They are all off by default. Only records created after a switch
is turned on (within the poller's window) are sent.

Master pushes treat Tally's "already exists" as success (connector 0.3.0+), so a re-send is harmless.
The ledgers named in the integration must exist in the Tally company; the dashboard checklist finds
missing ones and can create them with one click.

## Privacy

The connector talks only to the Kinematic API (the URLs in `config.json`) and to your
local Tally. No telemetry. `config.json` holds the agent secret; the installer restricts
the folder to SYSTEM and Administrators.
