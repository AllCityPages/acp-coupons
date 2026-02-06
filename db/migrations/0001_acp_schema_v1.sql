/* ============================================================
 ACP SQL Schema (v1) — Canonical, Global-ready, Compliance-first
 Target: PostgreSQL 14+
============================================================ */

/* ---------- Extensions (safe defaults) ---------- */
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

/* ---------- Schemas ---------- */
CREATE SCHEMA IF NOT EXISTS acp_core;
CREATE SCHEMA IF NOT EXISTS acp_i18n;
CREATE SCHEMA IF NOT EXISTS acp_dir;
CREATE SCHEMA IF NOT EXISTS acp_deals;
CREATE SCHEMA IF NOT EXISTS acp_ads;
CREATE SCHEMA IF NOT EXISTS acp_rei;
CREATE SCHEMA IF NOT EXISTS acp_ci;
CREATE SCHEMA IF NOT EXISTS acp_compliance;
CREATE SCHEMA IF NOT EXISTS acp_analytics;

/* ============================================================
 1) CORE: Tenancy, Identity, Access Control, Global Primitives
============================================================ */

/* ---------- Tenants (ACP publisher / market / operator) ---------- */
CREATE TABLE IF NOT EXISTS acp_core.tenants (
  tenant_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key           citext UNIQUE NOT NULL,          -- short stable key (e.g., "allcitypages")
  display_name         text NOT NULL,
  status               text NOT NULL DEFAULT 'active',  -- active|suspended|closed
  default_locale       text NOT NULL DEFAULT 'en-US',
  default_currency     char(3) NOT NULL DEFAULT 'USD',
  default_timezone     text NOT NULL DEFAULT 'America/Chicago',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON acp_core.tenants(status);

/* ---------- Organizations (business owners, agencies, brokerages) ---------- */
CREATE TABLE IF NOT EXISTS acp_core.organizations (
  org_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  org_type             text NOT NULL DEFAULT 'business', -- business|agency|brokerage|publisher|vendor
  legal_name           text NULL,
  display_name         text NOT NULL,
  tax_id_hash          text NULL, -- store hashed/normalized token if needed, never plaintext
  status               text NOT NULL DEFAULT 'active',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_orgs_tenant ON acp_core.organizations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orgs_type ON acp_core.organizations(org_type);

/* ---------- People (users, contacts; age-aware primitives live here) ---------- */
CREATE TABLE IF NOT EXISTS acp_core.people (
  person_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  -- Identity (minimize PII; prefer contact_points table)
  display_name         text NULL,
  given_name           text NULL,
  family_name          text NULL,

  -- Age-aware primitives (store minimal; do NOT store full DOB unless required)
  birth_date           date NULL,             -- optional; avoid unless necessary
  age_band             text NULL,             -- u13|13_15|16_17|18_20|21_plus|unknown (policy-driven)
  age_verified_at      timestamptz NULL,
  age_verification_method text NULL,          -- self_attest|idv|payment|third_party|unknown

  -- Status
  status               text NOT NULL DEFAULT 'active', -- active|invited|locked|closed
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz NULL,

  CONSTRAINT chk_age_band
    CHECK (age_band IS NULL OR age_band IN ('u13','13_15','16_17','18_20','21_plus','unknown'))
);

CREATE INDEX IF NOT EXISTS idx_people_tenant ON acp_core.people(tenant_id);
CREATE INDEX IF NOT EXISTS idx_people_age_band ON acp_core.people(age_band);

/* ---------- Membership (person ↔ org, org ↔ tenant) ---------- */
CREATE TABLE IF NOT EXISTS acp_core.org_memberships (
  membership_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  org_id               uuid NOT NULL REFERENCES acp_core.organizations(org_id),
  person_id            uuid NOT NULL REFERENCES acp_core.people(person_id),
  role                 text NOT NULL DEFAULT 'member', -- owner|admin|manager|analyst|member
  status               text NOT NULL DEFAULT 'active',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, org_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_org ON acp_core.org_memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_memberships_person ON acp_core.org_memberships(person_id);

/* ---------- Auth Accounts (login identity) ---------- */
CREATE TABLE IF NOT EXISTS acp_core.auth_accounts (
  account_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  person_id            uuid NOT NULL REFERENCES acp_core.people(person_id),

  provider             text NOT NULL,       -- password|google|apple|magic_link|sso|api
  provider_subject     text NULL,           -- external subject/user id
  email_canonical      citext NULL,
  password_hash        text NULL,           -- if provider=password
  mfa_enabled          boolean NOT NULL DEFAULT false,
  last_login_at        timestamptz NULL,
  status               text NOT NULL DEFAULT 'active',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, provider, provider_subject),
  UNIQUE (tenant_id, email_canonical)
);

CREATE INDEX IF NOT EXISTS idx_accounts_person ON acp_core.auth_accounts(person_id);

/* ---------- API Keys (server-to-server, integrations) ---------- */
CREATE TABLE IF NOT EXISTS acp_core.api_keys (
  api_key_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  org_id               uuid NULL REFERENCES acp_core.organizations(org_id),

  key_prefix           text NOT NULL,        -- e.g., "acp_live_"
  key_hash             text NOT NULL,        -- store hash only
  scopes               text[] NOT NULL DEFAULT ARRAY[]::text[],
  status               text NOT NULL DEFAULT 'active',

  created_by           uuid NULL REFERENCES acp_core.people(person_id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  rotated_at           timestamptz NULL,
  expires_at           timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON acp_core.api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON acp_core.api_keys(status);

/* ---------- Global geo primitives ---------- */
CREATE TABLE IF NOT EXISTS acp_core.countries (
  country_code         char(2) PRIMARY KEY, -- ISO-3166-1 alpha-2
  name_en              text NOT NULL,
  currency_code        char(3) NOT NULL,
  calling_code         text NULL
);

CREATE TABLE IF NOT EXISTS acp_core.admin_regions (
  region_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code         char(2) NOT NULL REFERENCES acp_core.countries(country_code),
  region_code          text NOT NULL,       -- e.g., "TX", "CA"
  name_en              text NOT NULL,
  UNIQUE (country_code, region_code)
);

CREATE TABLE IF NOT EXISTS acp_core.places (
  place_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  place_type           text NOT NULL,       -- city|metro|neighborhood|zip|poi|custom_area
  name                 text NOT NULL,
  country_code         char(2) NOT NULL REFERENCES acp_core.countries(country_code),
  region_id            uuid NULL REFERENCES acp_core.admin_regions(region_id),

  -- Geospatial (simple primitives; can be swapped to PostGIS later)
  latitude             numeric(9,6) NULL,
  longitude            numeric(9,6) NULL,
  geohash              text NULL,

  timezone             text NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, place_type, name, country_code, region_id)
);

CREATE INDEX IF NOT EXISTS idx_places_tenant ON acp_core.places(tenant_id);
CREATE INDEX IF NOT EXISTS idx_places_type ON acp_core.places(place_type);
CREATE INDEX IF NOT EXISTS idx_places_geohash ON acp_core.places(geohash);

/* ---------- Address (normalized, reusable) ---------- */
CREATE TABLE IF NOT EXISTS acp_core.addresses (
  address_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  line1                text NOT NULL,
  line2                text NULL,
  city                 text NOT NULL,
  region               text NULL,           -- fallback string
  postal_code          text NULL,
  country_code         char(2) NOT NULL REFERENCES acp_core.countries(country_code),

  place_id             uuid NULL REFERENCES acp_core.places(place_id),
  latitude             numeric(9,6) NULL,
  longitude            numeric(9,6) NULL,
  geohash              text NULL,

  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_addresses_tenant ON acp_core.addresses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_addresses_place ON acp_core.addresses(place_id);
CREATE INDEX IF NOT EXISTS idx_addresses_geohash ON acp_core.addresses(geohash);

/* ---------- Contact points (email, phone, url, social) ---------- */
CREATE TABLE IF NOT EXISTS acp_core.contact_points (
  contact_point_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  owner_type           text NOT NULL,  -- person|org|listing
  owner_id             uuid NOT NULL,

  kind                 text NOT NULL,  -- email|phone|sms|url|social|whatsapp|other
  value_raw            text NOT NULL,
  value_canonical      text NULL,      -- normalized form
  is_primary           boolean NOT NULL DEFAULT false,
  is_verified          boolean NOT NULL DEFAULT false,
  verified_at          timestamptz NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_owner ON acp_core.contact_points(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_contact_kind ON acp_core.contact_points(kind);

/* ============================================================
 2) I18N: Localized content, currency, money representation
============================================================ */

/* ---------- Locales ---------- */
CREATE TABLE IF NOT EXISTS acp_i18n.locales (
  locale               text PRIMARY KEY,   -- BCP 47, e.g. en-US, es-MX
  name_en              text NOT NULL,
  is_rtl               boolean NOT NULL DEFAULT false
);

/* ---------- Currency exchange (optional; global readiness) ---------- */
CREATE TABLE IF NOT EXISTS acp_i18n.fx_rates (
  fx_rate_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency        char(3) NOT NULL,
  quote_currency       char(3) NOT NULL,
  rate                 numeric(18,8) NOT NULL,
  as_of_date           date NOT NULL,
  source               text NULL,
  UNIQUE (base_currency, quote_currency, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_fx_asof ON acp_i18n.fx_rates(as_of_date);

/* ---------- Localized strings (generic, schema-level i18n primitive) ---------- */
CREATE TABLE IF NOT EXISTS acp_i18n.localized_text (
  localized_text_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  entity_type          text NOT NULL,
  entity_id            uuid NOT NULL,
  field_name           text NOT NULL, -- title|description|cta|etc
  locale               text NOT NULL REFERENCES acp_i18n.locales(locale),

  text_value           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, entity_type, entity_id, field_name, locale)
);

CREATE INDEX IF NOT EXISTS idx_localized_entity ON acp_i18n.localized_text(entity_type, entity_id);

/* ============================================================
 3) DIRECTORY: Listings, Categories, Plans, Upgrades
============================================================ */

/* ---------- Categories (hierarchical) ---------- */
CREATE TABLE IF NOT EXISTS acp_dir.categories (
  category_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  parent_id            uuid NULL REFERENCES acp_dir.categories(category_id),

  slug                 citext NOT NULL,
  name                 text NOT NULL,
  description          text NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_categories_parent ON acp_dir.categories(parent_id);

/* ---------- Listings (canonical local business / entity record) ---------- */
CREATE TABLE IF NOT EXISTS acp_dir.listings (
  listing_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  org_id               uuid NULL REFERENCES acp_core.organizations(org_id), -- owner org (optional)

  listing_type         text NOT NULL DEFAULT 'business', -- business|event|service|attraction|professional
  status               text NOT NULL DEFAULT 'draft',    -- draft|published|paused|closed
  slug                 citext NOT NULL,

  name                 text NOT NULL,
  tagline              text NULL,
  description          text NULL,

  address_id           uuid NULL REFERENCES acp_core.addresses(address_id),
  primary_place_id     uuid NULL REFERENCES acp_core.places(place_id),

  hours_json           jsonb NULL,
  attributes_json      jsonb NULL,  -- flexible features, amenities, etc (validated app-side)

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  published_at         timestamptz NULL,
  deleted_at           timestamptz NULL,

  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_listings_tenant_status ON acp_dir.listings(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_listings_place ON acp_dir.listings(primary_place_id);

/* ---------- Listing ↔ Category ---------- */
CREATE TABLE IF NOT EXISTS acp_dir.listing_categories (
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  listing_id           uuid NOT NULL REFERENCES acp_dir.listings(listing_id),
  category_id          uuid NOT NULL REFERENCES acp_dir.categories(category_id),
  PRIMARY KEY (tenant_id, listing_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_categories_cat ON acp_dir.listing_categories(category_id);

/* ---------- Plans (Bronze/Silver/Gold + global pricing) ---------- */
CREATE TABLE IF NOT EXISTS acp_dir.plans (
  plan_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  plan_key             citext NOT NULL,     -- bronze|silver|gold
  display_name         text NOT NULL,
  description          text NULL,

  billing_period       text NOT NULL DEFAULT 'month', -- month|year|one_time
  base_price_minor     bigint NOT NULL DEFAULT 0,     -- minor units (cents)
  currency_code        char(3) NOT NULL,

  features_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'active',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, plan_key, billing_period, currency_code)
);

CREATE INDEX IF NOT EXISTS idx_plans_tenant ON acp_dir.plans(tenant_id);

/* ---------- Upgrades (spotlight/top-of-search/sidebar/featured listing) ---------- */
CREATE TABLE IF NOT EXISTS acp_dir.upgrades (
  upgrade_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  upgrade_key          citext NOT NULL,  -- spotlight|top_search|sidebar|featured
  display_name         text NOT NULL,
  description          text NULL,

  pricing_model        text NOT NULL DEFAULT 'fixed', -- fixed|tiered|auction|cpm|cpc
  price_minor          bigint NULL,
  currency_code        char(3) NULL,
  duration_days        integer NULL,

  rules_json           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'active',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, upgrade_key)
);

CREATE INDEX IF NOT EXISTS idx_upgrades_tenant ON acp_dir.upgrades(tenant_id);

/* ---------- Listing Subscription (plan + upgrades attached) ---------- */
CREATE TABLE IF NOT EXISTS acp_dir.listing_subscriptions (
  subscription_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  listing_id           uuid NOT NULL REFERENCES acp_dir.listings(listing_id),
  plan_id              uuid NOT NULL REFERENCES acp_dir.plans(plan_id),

  status               text NOT NULL DEFAULT 'active', -- active|past_due|canceled|paused
  started_at           timestamptz NOT NULL DEFAULT now(),
  ends_at              timestamptz NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON acp_dir.listing_subscriptions(plan_id);

/* ---------- Subscription Upgrades (time-boxed) ---------- */
CREATE TABLE IF NOT EXISTS acp_dir.subscription_upgrades (
  subscription_upgrade_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  subscription_id      uuid NOT NULL REFERENCES acp_dir.listing_subscriptions(subscription_id),
  upgrade_id           uuid NOT NULL REFERENCES acp_dir.upgrades(upgrade_id),

  status               text NOT NULL DEFAULT 'active',
  starts_at            timestamptz NOT NULL DEFAULT now(),
  ends_at              timestamptz NULL,

  price_minor          bigint NULL,
  currency_code        char(3) NULL,
  metadata_json        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_upgrade_sub ON acp_dir.subscription_upgrades(subscription_id);
CREATE INDEX IF NOT EXISTS idx_sub_upgrade_upgrade ON acp_dir.subscription_upgrades(upgrade_id);

/* ============================================================
 4) DEALS / OFFERS: Offers, redemption, eligibility, constraints
============================================================ */

CREATE TABLE IF NOT EXISTS acp_deals.offers (
  offer_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  listing_id           uuid NOT NULL REFERENCES acp_dir.listings(listing_id),

  status               text NOT NULL DEFAULT 'draft', -- draft|active|paused|expired
  offer_type           text NOT NULL DEFAULT 'deal',  -- deal|coupon|event|leadmagnet|vip|seasonal
  title                text NOT NULL,
  description          text NULL,
  terms                text NULL,

  start_at             timestamptz NULL,
  end_at               timestamptz NULL,

  -- Value representation (flexible)
  discount_kind        text NULL,         -- percent|amount|bogo|bundle|freebie|other
  discount_value       numeric(18,6) NULL,
  currency_code        char(3) NULL,

  -- Constraints
  max_redemptions_total integer NULL,
  max_redemptions_per_user integer NULL,
  min_purchase_minor   bigint NULL,
  eligibility_json     jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g., new_customers_only, geo, membership tier

  -- Age gates (compliance primitive)
  min_age_years        integer NULL,
  age_gate_required    boolean NOT NULL DEFAULT false,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  published_at         timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_offers_listing_status ON acp_deals.offers(listing_id, status);
CREATE INDEX IF NOT EXISTS idx_offers_time ON acp_deals.offers(start_at, end_at);

/* ---------- Offer Codes ---------- */
CREATE TABLE IF NOT EXISTS acp_deals.offer_codes (
  offer_code_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  offer_id             uuid NOT NULL REFERENCES acp_deals.offers(offer_id),

  code                 citext NOT NULL,
  status               text NOT NULL DEFAULT 'active', -- active|disabled|exhausted
  max_uses             integer NULL,
  uses_count           integer NOT NULL DEFAULT 0,

  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, offer_id, code)
);

CREATE INDEX IF NOT EXISTS idx_offer_codes_offer ON acp_deals.offer_codes(offer_id);

/* ---------- Redemptions ---------- */
CREATE TABLE IF NOT EXISTS acp_deals.offer_redemptions (
  redemption_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  offer_id             uuid NOT NULL REFERENCES acp_deals.offers(offer_id),
  offer_code_id        uuid NULL REFERENCES acp_deals.offer_codes(offer_code_id),

  person_id            uuid NULL REFERENCES acp_core.people(person_id),  -- nullable for anonymous
  redeemed_at          timestamptz NOT NULL DEFAULT now(),
  channel              text NULL,  -- web|mobile|in_store|phone|other

  metadata_json        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_redemptions_offer ON acp_deals.offer_redemptions(offer_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_person ON acp_deals.offer_redemptions(person_id);

/* ============================================================
 5) ADS: Campaigns, Creatives, Placements (global-ready)
============================================================ */

CREATE TABLE IF NOT EXISTS acp_ads.campaigns (
  campaign_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  org_id               uuid NULL REFERENCES acp_core.organizations(org_id),
  listing_id           uuid NULL REFERENCES acp_dir.listings(listing_id),

  name                 text NOT NULL,
  objective            text NOT NULL DEFAULT 'awareness', -- awareness|traffic|leads|sales|calls
  status               text NOT NULL DEFAULT 'draft',     -- draft|active|paused|completed

  start_at             timestamptz NULL,
  end_at               timestamptz NULL,

  budget_minor         bigint NULL,
  currency_code        char(3) NULL,
  pacing               text NULL, -- daily|lifetime|asap|even

  targeting_json       jsonb NOT NULL DEFAULT '{}'::jsonb, -- geo, demo (age-safe), interests, etc

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON acp_ads.campaigns(status);

CREATE TABLE IF NOT EXISTS acp_ads.creatives (
  creative_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  campaign_id          uuid NULL REFERENCES acp_ads.campaigns(campaign_id),

  creative_type        text NOT NULL, -- image|video|html|native|email|print
  name                 text NULL,

  headline             text NULL,
  body                 text NULL,
  cta                  text NULL,

  asset_json           jsonb NOT NULL DEFAULT '{}'::jsonb, -- pointers to stored media
  safety_labels        text[] NOT NULL DEFAULT ARRAY[]::text[], -- brand safety flags
  status               text NOT NULL DEFAULT 'draft',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creatives_campaign ON acp_ads.creatives(campaign_id);

CREATE TABLE IF NOT EXISTS acp_ads.placements (
  placement_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  placement_key        citext NOT NULL, -- top_search|sidebar|featured|feed|email|print_issue|home_hero
  display_name         text NOT NULL,
  rules_json           jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, placement_key)
);

CREATE TABLE IF NOT EXISTS acp_ads.ad_flights (
  flight_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  campaign_id          uuid NOT NULL REFERENCES acp_ads.campaigns(campaign_id),
  placement_id         uuid NOT NULL REFERENCES acp_ads.placements(placement_id),
  creative_id          uuid NOT NULL REFERENCES acp_ads.creatives(creative_id),

  status               text NOT NULL DEFAULT 'active',
  start_at             timestamptz NULL,
  end_at               timestamptz NULL,

  bid_model            text NULL, -- cpm|cpc|fixed|sponsorship
  bid_minor            bigint NULL,
  currency_code        char(3) NULL,

  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flights_campaign ON acp_ads.ad_flights(campaign_id);
CREATE INDEX IF NOT EXISTS idx_flights_placement ON acp_ads.ad_flights(placement_id);

/* ============================================================
 6) REAL ESTATE INTELLIGENCE (above MLS): Canonical property graph,
    ingestion sources, signals, scoring, and recommendations
============================================================ */

/* ---------- External sources (MLS, county, assessor, AVM, etc.) ---------- */
CREATE TABLE IF NOT EXISTS acp_rei.sources (
  source_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  source_type          text NOT NULL,  -- mls|county|assessor|avm|rental|schools|crime|flood|user
  name                 text NOT NULL,
  license_notes        text NULL,
  status               text NOT NULL DEFAULT 'active',

  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_type, name)
);

/* ---------- Canonical parcels / properties ---------- */
CREATE TABLE IF NOT EXISTS acp_rei.parcels (
  parcel_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  country_code         char(2) NOT NULL REFERENCES acp_core.countries(country_code),
  parcel_key           text NOT NULL, -- normalized parcel/APN identifier
  address_id           uuid NULL REFERENCES acp_core.addresses(address_id),

  land_area_sqft       numeric(18,2) NULL,
  geometry_json        jsonb NULL, -- reserved for future PostGIS polygon
  created_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, country_code, parcel_key)
);

CREATE INDEX IF NOT EXISTS idx_parcels_address ON acp_rei.parcels(address_id);

CREATE TABLE IF NOT EXISTS acp_rei.properties (
  property_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  parcel_id            uuid NULL REFERENCES acp_rei.parcels(parcel_id),
  address_id           uuid NULL REFERENCES acp_core.addresses(address_id),
  primary_place_id     uuid NULL REFERENCES acp_core.places(place_id),

  property_type        text NOT NULL, -- sfr|townhome|condo|multi|land|commercial|other
  year_built           integer NULL,
  beds                 numeric(5,2) NULL,
  baths                numeric(5,2) NULL,
  living_area_sqft     numeric(18,2) NULL,
  lot_area_sqft        numeric(18,2) NULL,

  canonical_status     text NOT NULL DEFAULT 'active', -- active|merged|retired
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_properties_place ON acp_rei.properties(primary_place_id);
CREATE INDEX IF NOT EXISTS idx_properties_type ON acp_rei.properties(property_type);

/* ---------- Imported listings (MLS etc.) separate from canonical property ---------- */
CREATE TABLE IF NOT EXISTS acp_rei.source_listings (
  source_listing_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  source_id            uuid NOT NULL REFERENCES acp_rei.sources(source_id),

  source_listing_key   text NOT NULL, -- MLS number or external id
  property_id          uuid NULL REFERENCES acp_rei.properties(property_id),

  listing_status       text NOT NULL, -- active|pending|sold|off_market|expired|unknown
  list_price_minor     bigint NULL,
  sold_price_minor     bigint NULL,
  currency_code        char(3) NULL,
  list_date            date NULL,
  sold_date            date NULL,

  raw_payload          jsonb NOT NULL DEFAULT '{}'::jsonb, -- keep raw (license-aware)
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, source_id, source_listing_key)
);

CREATE INDEX IF NOT EXISTS idx_source_listings_property ON acp_rei.source_listings(property_id);
CREATE INDEX IF NOT EXISTS idx_source_listings_status ON acp_rei.source_listings(listing_status);

/* ---------- Neighborhood / micro-market ---------- */
CREATE TABLE IF NOT EXISTS acp_rei.neighborhoods (
  neighborhood_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  name                 text NOT NULL,
  place_id             uuid NULL REFERENCES acp_core.places(place_id),
  boundary_json        jsonb NULL, -- reserved for polygon
  created_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, name, place_id)
);

CREATE TABLE IF NOT EXISTS acp_rei.property_neighborhoods (
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  property_id          uuid NOT NULL REFERENCES acp_rei.properties(property_id),
  neighborhood_id      uuid NOT NULL REFERENCES acp_rei.neighborhoods(neighborhood_id),
  confidence           numeric(5,4) NOT NULL DEFAULT 1.0,
  PRIMARY KEY (tenant_id, property_id, neighborhood_id)
);

/* ---------- Signals (features) and observations (time series) ---------- */
CREATE TABLE IF NOT EXISTS acp_rei.signal_definitions (
  signal_def_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  signal_key           citext NOT NULL, -- e.g., "price_per_sqft", "days_on_market", "flood_risk"
  display_name         text NOT NULL,
  signal_type          text NOT NULL,   -- numeric|boolean|text|score|json
  unit                text NULL,
  description          text NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, signal_key)
);

CREATE TABLE IF NOT EXISTS acp_rei.signal_observations (
  observation_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  signal_def_id        uuid NOT NULL REFERENCES acp_rei.signal_definitions(signal_def_id),
  source_id            uuid NULL REFERENCES acp_rei.sources(source_id),

  entity_type          text NOT NULL, -- property|neighborhood|place
  entity_id            uuid NOT NULL,

  observed_at          timestamptz NOT NULL DEFAULT now(),
  value_numeric        numeric(18,6) NULL,
  value_text           text NULL,
  value_bool           boolean NULL,
  value_json           jsonb NULL,

  confidence           numeric(5,4) NOT NULL DEFAULT 1.0,
  metadata_json        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_observations_entity ON acp_rei.signal_observations(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_observations_signal_time ON acp_rei.signal_observations(signal_def_id, observed_at);

/* ---------- Decision layer: scoring models + recommendations ---------- */
CREATE TABLE IF NOT EXISTS acp_rei.scoring_models (
  model_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  model_key            citext NOT NULL,  -- "buyer_fit_v1", "investor_yield_v1"
  display_name         text NOT NULL,
  version              text NOT NULL DEFAULT '1',
  model_type           text NOT NULL,    -- rules|ml|hybrid
  config_json          jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL DEFAULT 'active',

  UNIQUE (tenant_id, model_key, version)
);

CREATE TABLE IF NOT EXISTS acp_rei.model_scores (
  score_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  model_id             uuid NOT NULL REFERENCES acp_rei.scoring_models(model_id),
  entity_type          text NOT NULL, -- property|neighborhood|place
  entity_id            uuid NOT NULL,

  scored_at            timestamptz NOT NULL DEFAULT now(),
  score_value          numeric(10,6) NOT NULL,
  score_band           text NULL, -- low|med|high|A|B|C etc
  explanation_json     jsonb NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (tenant_id, model_id, entity_type, entity_id, scored_at)
);

CREATE INDEX IF NOT EXISTS idx_model_scores_entity ON acp_rei.model_scores(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS acp_rei.recommendations (
  recommendation_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  person_id            uuid NULL REFERENCES acp_core.people(person_id), -- for personalized
  entity_type          text NOT NULL, -- property|neighborhood|place|listing
  entity_id            uuid NOT NULL,

  rec_type             text NOT NULL, -- buy|avoid|watch|visit|call|invest|rent
  priority             integer NOT NULL DEFAULT 0,
  rationale            text NULL,
  rationale_json       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_recs_person ON acp_rei.recommendations(person_id);
CREATE INDEX IF NOT EXISTS idx_recs_entity ON acp_rei.recommendations(entity_type, entity_id);

/* ============================================================
 7) CREATIVE INTELLIGENCE ENGINE (Phase 3+ reserved tables)
    - Prompting, briefs, generations, evaluation, safety
============================================================ */

/* ---------- Creative projects / briefs ---------- */
CREATE TABLE IF NOT EXISTS acp_ci.creative_projects (
  project_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  org_id               uuid NULL REFERENCES acp_core.organizations(org_id),
  listing_id           uuid NULL REFERENCES acp_dir.listings(listing_id),

  name                 text NOT NULL,
  goal                 text NULL,
  status               text NOT NULL DEFAULT 'active',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS acp_ci.creative_briefs (
  brief_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  project_id           uuid NOT NULL REFERENCES acp_ci.creative_projects(project_id),

  brief_version        integer NOT NULL DEFAULT 1,
  voice_guidelines     text NULL,     -- "your unique creative voice"
  audience_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  offer_context_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  constraints_json     jsonb NOT NULL DEFAULT '{}'::jsonb, -- platform, time, legal, brand

  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, brief_version)
);

/* ---------- Prompt templates (vault + re-usable patterns) ---------- */
CREATE TABLE IF NOT EXISTS acp_ci.prompt_templates (
  template_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  template_key         citext NOT NULL,
  name                 text NOT NULL,
  purpose              text NULL,      -- storyboard|hooks|thumbnails|emails|print_ad|etc
  prompt_text          text NOT NULL,
  variables_schema     jsonb NOT NULL DEFAULT '{}'::jsonb,

  safety_profile       text NULL,      -- reserved (brand safety profile)
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, template_key)
);

CREATE TABLE IF NOT EXISTS acp_ci.model_registry (
  model_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor               text NOT NULL,       -- openai|anthropic|local|etc
  model_name           text NOT NULL,
  model_version        text NULL,
  capabilities         text[] NOT NULL DEFAULT ARRAY[]::text[], -- text|image|video|audio
  policy_notes         text NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, model_name, model_version)
);

/* ---------- Generations (script, storyboard, video, print, etc.) ---------- */
CREATE TABLE IF NOT EXISTS acp_ci.generations (
  generation_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  project_id           uuid NOT NULL REFERENCES acp_ci.creative_projects(project_id),
  brief_id             uuid NULL REFERENCES acp_ci.creative_briefs(brief_id),

  template_id          uuid NULL REFERENCES acp_ci.prompt_templates(template_id),
  model_id             uuid NULL REFERENCES acp_ci.model_registry(model_id),

  generation_type      text NOT NULL, -- script|storyboard|video|image|email|infographic|print_ad
  input_json           jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json          jsonb NOT NULL DEFAULT '{}'::jsonb, -- store references to assets, not raw media blobs
  status               text NOT NULL DEFAULT 'completed',

  created_by           uuid NULL REFERENCES acp_core.people(person_id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generations_project ON acp_ci.generations(project_id);

/* ---------- Evaluation & Safety (reserved) ---------- */
CREATE TABLE IF NOT EXISTS acp_ci.evaluations (
  evaluation_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  generation_id        uuid NOT NULL REFERENCES acp_ci.generations(generation_id),

  rubric_key           text NOT NULL, -- ctr_proxy|brand_voice|policy|quality
  score                numeric(10,6) NULL,
  verdict              text NULL,     -- pass|warn|fail
  notes                text NULL,
  detail_json          jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evals_generation ON acp_ci.evaluations(generation_id);

/* ============================================================
 8) COMPLIANCE: Consent, Age Gates, Retention, DSAR, Audit
============================================================ */

/* ---------- Policy versions (terms, privacy, cookies, age policy) ---------- */
CREATE TABLE IF NOT EXISTS acp_compliance.policy_versions (
  policy_version_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  policy_type          text NOT NULL, -- terms|privacy|cookies|age|acceptable_use|mls_license
  version              text NOT NULL,
  effective_at         timestamptz NOT NULL,
  content_hash         text NOT NULL, -- hash of canonical policy text/PDF
  locale               text NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_type, version, locale)
);

CREATE INDEX IF NOT EXISTS idx_policy_effective ON acp_compliance.policy_versions(effective_at);

/* ---------- Consent records (purpose limitation + jurisdiction) ---------- */
CREATE TABLE IF NOT EXISTS acp_compliance.consents (
  consent_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  person_id            uuid NULL REFERENCES acp_core.people(person_id),

  jurisdiction         text NOT NULL, -- e.g., US-TX, EU, CA-BC (policy-defined)
  purpose              text NOT NULL, -- marketing|analytics|sms|email|personalization|age_gate
  lawful_basis         text NULL,     -- consent|contract|legitimate_interest|legal_obligation

  granted              boolean NOT NULL,
  granted_at           timestamptz NULL,
  revoked_at           timestamptz NULL,

  policy_version_id    uuid NULL REFERENCES acp_compliance.policy_versions(policy_version_id),

  proof_json           jsonb NOT NULL DEFAULT '{}'::jsonb, -- IP, user agent, flow id, etc
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consents_person ON acp_compliance.consents(person_id);
CREATE INDEX IF NOT EXISTS idx_consents_purpose ON acp_compliance.consents(purpose);

/* ---------- Age gate events (do not store excess PII) ---------- */
CREATE TABLE IF NOT EXISTS acp_compliance.age_gate_events (
  age_gate_event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  person_id            uuid NULL REFERENCES acp_core.people(person_id),

  context              text NOT NULL, -- offer|listing|ad|signup|checkout
  entity_type          text NULL,
  entity_id            uuid NULL,

  min_age_years        integer NOT NULL,
  outcome              text NOT NULL, -- pass|fail|unknown
  method               text NULL,     -- self_attest|idv|payment|third_party|unknown

  created_at           timestamptz NOT NULL DEFAULT now(),
  metadata_json        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_age_gate_person ON acp_compliance.age_gate_events(person_id);

/* ---------- Data retention rules (schema primitive) ---------- */
CREATE TABLE IF NOT EXISTS acp_compliance.retention_rules (
  retention_rule_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  entity_type          text NOT NULL,     -- e.g., "offer_redemptions"
  retention_days       integer NOT NULL,  -- e.g., 365
  action              text NOT NULL DEFAULT 'delete', -- delete|anonymize|archive
  jurisdiction        text NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, jurisdiction)
);

/* ---------- DSAR (data subject access requests) ---------- */
CREATE TABLE IF NOT EXISTS acp_compliance.dsar_requests (
  dsar_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  person_id            uuid NULL REFERENCES acp_core.people(person_id),

  request_type         text NOT NULL, -- access|delete|rectify|export|opt_out
  status               text NOT NULL DEFAULT 'open', -- open|in_review|fulfilled|denied|closed
  requested_at         timestamptz NOT NULL DEFAULT now(),
  fulfilled_at         timestamptz NULL,

  notes                text NULL,
  metadata_json        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_dsar_person ON acp_compliance.dsar_requests(person_id);

/* ---------- Audit log (immutable-ish primitive) ---------- */
CREATE TABLE IF NOT EXISTS acp_compliance.audit_log (
  audit_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  actor_type           text NULL, -- person|api_key|system
  actor_id             uuid NULL,
  action               text NOT NULL, -- create|update|delete|publish|redeem|login|export|etc

  entity_type          text NULL,
  entity_id            uuid NULL,

  occurred_at          timestamptz NOT NULL DEFAULT now(),
  ip_address           text NULL,
  user_agent           text NULL,
  detail_json          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON acp_compliance.audit_log(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON acp_compliance.audit_log(entity_type, entity_id);

/* ============================================================
 9) ANALYTICS: Events + rollups (privacy-friendly primitives)
============================================================ */

CREATE TABLE IF NOT EXISTS acp_analytics.event_stream (
  event_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),

  occurred_at          timestamptz NOT NULL DEFAULT now(),
  event_name           text NOT NULL, -- page_view|click|call|lead|redeem|save|share
  entity_type          text NULL,     -- listing|offer|creative|campaign|property
  entity_id            uuid NULL,

  person_id            uuid NULL REFERENCES acp_core.people(person_id), -- nullable; avoid if not consented
  session_id           text NULL,
  anonymous_id         text NULL, -- cookie/device pseudonym (consent-controlled)

  properties_json      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_event_time ON acp_analytics.event_stream(occurred_at);
CREATE INDEX IF NOT EXISTS idx_event_entity ON acp_analytics.event_stream(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_event_person ON acp_analytics.event_stream(person_id);

/* ---------- Materialized rollup table primitive (optional) ---------- */
CREATE TABLE IF NOT EXISTS acp_analytics.daily_rollups (
  tenant_id            uuid NOT NULL REFERENCES acp_core.tenants(tenant_id),
  rollup_date          date NOT NULL,
  entity_type          text NOT NULL,
  entity_id            uuid NOT NULL,

  views                bigint NOT NULL DEFAULT 0,
  clicks               bigint NOT NULL DEFAULT 0,
  leads                bigint NOT NULL DEFAULT 0,
  redemptions          bigint NOT NULL DEFAULT 0,

  PRIMARY KEY (tenant_id, rollup_date, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_rollups_entity ON acp_analytics.daily_rollups(entity_type, entity_id);
