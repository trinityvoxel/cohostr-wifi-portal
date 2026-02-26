#!/usr/bin/with-contenv bashio

export PROPERTY_ID=$(bashio::config 'property_id')
export PROPERTY_NAME=$(bashio::config 'property_name')
export PROPERTY_LOCATION=$(bashio::config 'property_location')
export PROPERTY_LISTING_URL=$(bashio::config 'property_listing_url')
export PROPERTY_IMAGE_URL=$(bashio::config 'property_image_url')
export PORT=$(bashio::config 'port')
export UNIFI_HOST=$(bashio::config 'unifi_host')
export UNIFI_USER=$(bashio::config 'unifi_user')
export UNIFI_PASS=$(bashio::config 'unifi_pass')
export UNIFI_SITE=$(bashio::config 'unifi_site')
export CF_ACCOUNT_ID=$(bashio::config 'cloudflare_account_id')
export CF_D1_DATABASE_ID=$(bashio::config 'cloudflare_d1_database_id')
export CF_API_TOKEN=$(bashio::config 'cloudflare_api_token')
export GOOGLE_SHEET_ID=$(bashio::config 'google_sheet_id')
export GOOGLE_CLIENT_EMAIL=$(bashio::config 'google_client_email')
export GOOGLE_PRIVATE_KEY=$(bashio::config 'google_private_key')

bashio::log.info "Starting CohoSTR WiFi Portal for property: ${PROPERTY_NAME} (${PROPERTY_ID}) on port ${PORT}"

node /app/server.js
