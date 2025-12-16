# Policy Alignment Index

An evidence-first platform for profiling Australian politicians based on their voting records and policy positions.

## Overview

The Policy Alignment Index provides:
- **Issue-category scores** derived from mapped voting records
- **Overall Policy Alignment Index** (0–100) with coverage indicators
- **Evidence-linked scoring** - every score traces back to specific votes
- **Audit trail** - all raw data stored for reproducibility

## Architecture

### Components

1. **ETL Pipelines** (Cloudflare Workers)
   - Ingest data from OpenAustralia and TheyVoteForYou APIs
   - Store raw payloads in R2 for audit
   - Normalize and store in D1 database

2. **Scoring Engine**
   - Versioned scoring algorithm
   - Category-based scoring with configurable weights
   - Generates detailed evidence trails

3. **Public API** (Astro + Workers)
   - Stable JSON contracts
   - KV-cached for performance
   - D1-first (never blocks on upstream)

4. **Demo UI**
   - Mobile-responsive interface
   - Evidence drilldown capability
   - Real-time filtering

## Data Sources

### Primary Sources
- **OpenAustralia** - MPs, Senators, divisions, votes
- **TheyVoteForYou** - Policy groupings, curated data

### Enrichment (Optional)
- **Wikidata** - Photos, biographical data
- **Wikipedia** - Additional context

## Scoring Algorithm

### Vote Impact
- `AYE` on pro-direction division → +1 × strength
- `NO` on pro-direction division → -1 × strength
- Anti-direction inverts signs
- Abstain/absent → 0

### Category Score
```
raw_score = Σ(strength × impact)
max_possible = Σ(strength)
score_signed = 100 × (raw_score / max_possible)  // -100 to 100
score_0_100 = (score_signed + 100) / 2
coverage = voted_count / total_mapped_count
```

### Overall Score
Weighted average across categories, adjusted by coverage.

## Database Schema

### Core Tables
- `politicians` - Roster with external IDs
- `parties` - Political parties
- `divisions` - Vote events
- `votes` - Individual votes per division
- `categories` - Policy categories

### Mapping & Scoring
- `division_mappings` - Maps divisions to categories
- `score_runs` - Versioned scoring runs
- `politician_category_scores` - Category scores per politician
- `politician_overall_scores` - Overall scores
- `score_explanations` - Evidence trail

### Audit
- `raw_documents` - R2 keys for raw data
- `mapping_queue` - Unmapped divisions

## API Endpoints

### Public API (v1)

- `GET /api/v1/meta.json` - Framework version and timestamps
- `GET /api/v1/categories.json` - Category definitions
- `GET /api/v1/politicians.json` - Directory with filters
- `GET /api/v1/politicians/{id}.json` - Profile with scores
- `GET /api/v1/politicians/{id}/evidence.json` - Evidence items
- `GET /api/v1/divisions.json` - Admin helper for mapping

### Internal Endpoints

- `POST /api/internal/etl/seed-categories` - Seed default categories
- `POST /api/internal/etl/roster` - Sync politician roster
- `POST /api/internal/etl/divisions` - Sync divisions and votes
- `POST /api/internal/scorer/run` - Run scoring algorithm

## Deployment

### Requirements
- Cloudflare account with Workers, D1, KV, R2
- OpenAustralia API key

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure secrets:
   ```bash
   wrangler secret put OPENAUSTRALIA_API_KEY
   ```

3. Run migrations:
   ```bash
   wrangler d1 execute australiafirst --file=./migrations/0001_core_tables.sql
   wrangler d1 execute australiafirst --file=./migrations/0002_division_mappings.sql
   wrangler d1 execute australiafirst --file=./migrations/0003_score_tables.sql
   wrangler d1 execute australiafirst --file=./migrations/0004_audit_tables.sql
   ```

4. Seed categories:
   ```bash
   curl -X POST https://your-worker.workers.dev/api/internal/etl/seed-categories
   ```

5. Deploy:
   ```bash
   npm run deploy
   ```

## Development

```bash
# Start dev server
npm run dev

# Build for production
npm run build

# Preview build
npm run preview

# Type checking
npm run check
```

## Provenance & Audit

### Raw Data Storage
All upstream API responses are stored in R2 with:
- SHA256 hash for integrity
- Timestamp of fetch
- Source identifier

### Reproducibility
- ETL is idempotent (safe to re-run)
- Scoring is versioned (framework_version)
- All scores link to evidence

### Transparency
- Every score shows contributing votes
- Division mappings include rationale
- Coverage metrics show data completeness

## Disclaimer

This platform presents scoring based on public voting records. Scores reflect alignment with defined policy categories and should be interpreted with:
- Understanding of the scoring methodology
- Awareness of coverage limitations
- Recognition that voting records are one aspect of representation

All data is sourced from public records and APIs. Please verify critical information against primary sources.

## License

See LICENSE file for details.
