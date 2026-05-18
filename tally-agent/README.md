# Kinematic Tally Connector

Bridge agent that runs alongside **Tally Prime** (or Tally ERP 9) on the
distributor's PC. It polls Kinematic every 30 seconds for pending voucher
jobs, posts them to the local Tally HTTP/XML interface, and reports the
resulting Tally voucher IDs back so reconciliation works both ways.

Zero external dependencies — just Node 18+.

## Install (Windows, ~5 minutes)

### 1. Install Node 18 or newer

Download the LTS installer from <https://nodejs.org/> and run it. Tick
"Add to PATH" so `node` and `npm` work from any terminal.

Verify:

```
node --version
```

Expect `v18.x.x` or higher.

### 2. Get the connector code on the Tally PC

Option A — clone (if Git is available):

```
git clone https://github.com/Shaggywize63/Kinematic.git
cd Kinematic\tally-agent
```

Option B — download zip:

1. Go to <https://github.com/Shaggywize63/Kinematic/archive/refs/heads/main.zip>
2. Extract it.
3. Open `kinematic-main\tally-agent\` in File Explorer.

### 3. Drop in your config file

1. Log into the Kinematic dashboard as an admin.
2. Open **Distribution → Integrations**.
3. Click the Tally connection you created (or **+ Add integration** → Tally).
4. Click **Download kinematic-tally-config.json** in the success modal.
5. Save the file as `config.json` next to `index.js` in the tally-agent folder.

The file looks like:

```json
{
  "integration_id":        "abc-...",
  "agent_secret":          "...",
  "polling_endpoint":      "https://kinematic-production.up.railway.app/api/v1/integrations/tally/jobs/.../?key=...",
  "report_endpoint":       "https://kinematic-production.up.railway.app/api/v1/integrations/tally/jobs/.../result?key=...",
  "tally_url":             "http://localhost:9000",
  "poll_interval_seconds": 30
}
```

If your Tally runs on a different port or a remote machine, edit `tally_url`.

### 4. Enable Tally's HTTP/XML interface

In Tally Prime:

1. Press F1 → **Settings** → **Connectivity** → **Client/Server configuration**.
2. Set **TallyPrime acts as** to **Both**.
3. Set **Port** to **9000** (default).
4. Save and close. Restart Tally if prompted.

### 5. Run the connector

From a Command Prompt opened in the `tally-agent` folder:

```
npm start
```

You should see:

```
Kinematic Tally Connector
  integration_id: abc-...
  tally_url:      http://localhost:9000
  cadence:        30s
```

As invoices / payments / returns happen in Kinematic, lines like this appear:

```
[2026-05-18T10:30:12.345Z] processing 2 job(s)
  ✓ invoice 8a... → Tally voucher 123 (412ms)
  ✓ payment 7b... → Tally voucher 124 (387ms)
```

## Run continuously (auto-start on boot)

Windows Task Scheduler is the simplest option:

1. Open **Task Scheduler** → **Create Task…**
2. **Name**: `Kinematic Tally Connector`.
3. **General** tab: tick **Run whether user is logged on or not**.
4. **Triggers** tab: **New → Begin the task: At startup**.
5. **Actions** tab: **New → Start a program**:
   - **Program/script**: `C:\Program Files\nodejs\node.exe` (adjust if Node is elsewhere)
   - **Add arguments**: `index.js`
   - **Start in**: the full path to your `tally-agent` folder (e.g. `C:\Users\...\tally-agent`)
6. **Conditions** tab: untick **Start the task only if the computer is on AC power** if this is a laptop.
7. **Settings** tab: tick **If the task fails, restart every: 1 minute** with **Attempt to restart up to: 3 times**.
8. OK → enter your Windows password.

The connector now runs in the background whenever the Tally PC is on.

## Run a one-off catch-up

If the connector has been offline for a while, run a single drain pass:

```
npm run once
```

It fetches every pending job, processes them all, and exits.

## Troubleshooting

**`[FATAL] Config not found at config.json`**
Download it from the Kinematic dashboard (Distribution → Integrations → your
Tally integration → success modal) and save it next to `index.js`.

**`Tally connection failed: connect ECONNREFUSED 127.0.0.1:9000`**
Tally is not running, or its HTTP/XML interface is disabled. See step 4 above.

**`Tally HTTP 400: ...LINEERROR : Unknown company...`**
The Tally company name in the integration config doesn't match the company
currently loaded in Tally. Either open the right company in Tally, or update
the **Tally company name** field in the Kinematic dashboard.

**`Tally HTTP 400: ...LINEERROR : Ledger 'Sales Account' does not exist...`**
One of the ledger names you configured doesn't exist in this Tally company.
Either create it in Tally (Gateway → Create → Ledger) or update the
ledger-name field in the Kinematic dashboard to match Tally exactly
(spaces and case matter).

**Kinematic dashboard shows "Agent seen N hours ago"**
The connector isn't running, or it can't reach Kinematic. Open the
connector terminal: if it's crashed, restart with `npm start`. If it's
running but stalled, check the PC's internet connection.

## What gets pushed to Tally

| Kinematic event | Tally voucher type | Notes |
|---|---|---|
| Invoice (status=issued) | Sales | Includes CGST/SGST/IGST/Cess as separate ledger entries; party is debited by the grand total. Round-off included if non-zero. |
| Payment (status=cleared) | Receipt | Bill allocations link the payment back to the original invoice (Agst Ref) so Tally's outstanding tracking stays correct. Cash mode debits Cash ledger; everything else debits Bank ledger. |
| Return (status=credited / supervisor_approved) | Credit Note | Sales returns ledger debited; party credited with the full amount. |

Master sync (creating distributors as Tally ledgers, SKUs as stock
items) and inventory entries on sales vouchers are scheduled for v2.
For v1, all ledgers and stock items must already exist in Tally.

## Privacy

The connector talks only to:

- Kinematic API (`polling_endpoint` and `report_endpoint` from `config.json`)
- Your local Tally (`tally_url`, default `http://localhost:9000`)

No external services, no telemetry. `config.json` carries an agent secret
in URL form — keep it on the Tally PC only.
