# AGORA Output Schemas

AGORA has two task shapes. Pick by whether the inbox spec has a `target_address`.

## General task (no `target_address`)

Most categories (data, research, content, dev, general). Write:

```json
{
  "summary": "Translated 2,043 words EN→JA; kept technical terms.",
  "result_url": "https://gist.github.com/…/translated.md"
}
```

`summary` is required (the headline result). `result_url` is optional — use it
to point at the real deliverable when it's large.

## On-chain intel report (`target_address` present)

The worker submits this JSON object as `report`.

Required top-level fields:

```json
{
  "token_name": "Token name or Unknown Token",
  "token_symbol": "SYMBOL or UNK",
  "verdict": "low",
  "safety": [],
  "fund_flow": [],
  "smart_money": [],
  "deployer": {},
  "assessment": [],
  "sources": []
}
```

Allowed `verdict` values:

- `low`
- `medium`
- `high`
- `critical`

`safety` facts:

```json
{ "key": "honeypot", "status": "pass", "value": "Sellable" }
```

Recommended safety keys:

- `honeypot`
- `mintable`
- `ownerPrivileges`
- `tax`
- `lpLocked`
- `verified`
- `topHolders`

Allowed safety statuses:

- `pass`
- `warn`
- `danger`
- `info`

`fund_flow` entries:

```json
{ "title": "Funding source identified", "detail": "Short evidence-backed detail.", "flag": "info" }
```

Allowed `fund_flow.flag` values:

- `danger`
- `warn`
- `info`

`smart_money` entries:

```json
{ "address": "0x...", "kind": "whale", "amountPct": 12.3, "note": "Why this wallet matters." }
```

`deployer` object:

```json
{ "address": "0x...", "priorTokens": 0, "rugCount": 0, "note": "Evidence-backed summary." }
```

`assessment`:

- Array of concise conclusion strings.
- Include the main reason for the verdict.

`sources`:

```json
{ "label": "BscScan contract", "url": "https://bscscan.com/address/0x..." }
```

Every report should include at least one source.

