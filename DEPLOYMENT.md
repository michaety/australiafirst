# Deployment Guide - Policy Alignment Index

This guide walks through deploying the Policy Alignment Index to Cloudflare Workers.

## Prerequisites

1. Cloudflare account with Workers access
2. OpenAustralia API key ([register here](https://www.openaustralia.org.au/api/))
3. Wrangler CLI installed (`npm install -g wrangler`)

## Step 1: Configure Cloudflare Resources

### Create D1 Database

```bash
# Create the database (if not already created)
wrangler d1 create australiafirst
```

Note the database ID and update `wrangler.json` if different from:
- `database_id: f9e743c7-e125-4d30-a75c-60d4c5fe52eb`

### Create KV Namespace

```bash
# Create KV namespace (if not already created)
wrangler kv:namespace create "australiafirst"
```

Note the namespace ID and update `wrangler.json` if different from:
- `id: f8163c67a46d4e41a0a58b114180966a`

### Create R2 Bucket

```bash
# Create R2 bucket (if not already created)
wrangler r2 bucket create australiafirst
```

## Step 2: Run Database Migrations

Execute all migrations in order:

```bash
# Migration 1: Core tables
wrangler d1 execute australiafirst --file=./migrations/0001_core_tables.sql

# Migration 2: Division mappings
wrangler d1 execute australiafirst --file=./migrations/0002_division_mappings.sql

# Migration 3: Score tables
wrangler d1 execute australiafirst --file=./migrations/0003_score_tables.sql

# Migration 4: Audit tables
wrangler d1 execute australiafirst --file=./migrations/0004_audit_tables.sql
```

Verify migrations:
```bash
wrangler d1 execute australiafirst --command="SELECT name FROM sqlite_master WHERE type='table'"
```

## Step 3: Configure Secrets

```bash
# Set OpenAustralia API key
wrangler secret put OPENAUSTRALIA_API_KEY
# Enter your API key when prompted

# (Optional) Set TheyVoteForYou API key
wrangler secret put THEYVOTEFORYOU_API_KEY
```

## Step 4: Deploy

```bash
# Build and deploy
npm run build
wrangler deploy
```

Your worker will be deployed to: `https://australiafirst.<your-subdomain>.workers.dev`

## Step 5: Initial Data Seeding

After deployment, seed the initial data:

```bash
# 1. Seed categories
curl -X POST https://australiafirst.<your-subdomain>.workers.dev/api/internal/etl/seed-categories

# 2. Sync politician roster
curl -X POST https://australiafirst.<your-subdomain>.workers.dev/api/internal/etl/roster

# 3. Sync divisions (this may take a while)
curl -X POST https://australiafirst.<your-subdomain>.workers.dev/api/internal/etl/divisions
```

## Step 6: Configure Cron Triggers (Optional)

The `wrangler.json` already includes cron schedules:
- `0 2 * * *` - Daily at 2 AM (roster + divisions sync)
- `0 3 * * 0` - Weekly on Sunday at 3 AM (optional enrichment)

To activate cron triggers, ensure you have a paid Workers plan.

## Step 7: Create Initial Division Mappings

Since the system starts with no division mappings, you'll need to:

1. View unmapped divisions:
   ```bash
   curl https://australiafirst.<your-subdomain>.workers.dev/api/v1/divisions.json?mapped=false
   ```

2. Manually insert division mappings via D1:
   ```bash
   wrangler d1 execute australiafirst --command="
   INSERT INTO division_mappings (division_id, category_id, direction, strength, rationale)
   VALUES ('<division-id>', 'economic-resilience', 'pro', 1.0, 'Supports fiscal policy');
   "
   ```

3. Update mapping queue status:
   ```bash
   wrangler d1 execute australiafirst --command="
   UPDATE mapping_queue SET status='done' WHERE division_id='<division-id>';
   "
   ```

## Step 8: Run Initial Scoring

Once you have some division mappings:

```bash
curl -X POST https://australiafirst.<your-subdomain>.workers.dev/api/internal/scorer/run
```

## Step 9: Test the Demo UI

Visit: `https://australiafirst.<your-subdomain>.workers.dev/demo`

You should see:
- Category list
- Politician directory
- Filtering capabilities

## Troubleshooting

### API Returns Empty Results

**Problem:** APIs return empty arrays for politicians/divisions  
**Solution:** Ensure ETL jobs have run successfully. Check KV cache TTL.

### 500 Errors on API Calls

**Problem:** Internal server errors  
**Solution:** Check wrangler logs:
```bash
wrangler tail
```

### Division Mappings Not Working

**Problem:** Scores not calculating  
**Solution:** Verify division mappings exist in D1:
```bash
wrangler d1 execute australiafirst --command="SELECT COUNT(*) FROM division_mappings"
```

### Cron Jobs Not Running

**Problem:** ETL not running automatically  
**Solution:** Verify you have a paid Workers plan. Check cron trigger configuration in dashboard.

## Local Development

For local development with Wrangler:

```bash
# Create local .env file
cp .env.example .env
# Add your API keys to .env

# Start local dev server (note: D1, KV, R2 will use production bindings)
npm run dev
```

## Monitoring

View real-time logs:
```bash
wrangler tail
```

Check D1 database stats:
```bash
wrangler d1 info australiafirst
```

Check KV namespace usage:
```bash
wrangler kv:namespace list
```

## Security Notes

1. Never commit API keys or secrets
2. Rotate API keys periodically
3. Consider adding authentication to internal endpoints
4. Monitor R2 bucket size and costs
5. Review D1 query patterns for optimization

## Next Steps

1. Build admin UI for division mapping
2. Implement Wikidata enrichment
3. Add more sophisticated scoring models
4. Create public-facing politician profiles
5. Add analytics and monitoring

## Support

For issues or questions:
- Check the main README.md
- Review Cloudflare Workers documentation
- OpenAustralia API docs: https://www.openaustralia.org.au/api/
