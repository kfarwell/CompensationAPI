# Compensation Social API
This was the repository containing all API code for the Compensation Social official servers.
It has since been archived due to the official servers being shut down. If you wish to host
your own server, we recommend creating a fork of this repository and continuing from there.
  
Best of luck, and we hope you enjoy Compensation Social!

# Prerequisites
* NodeJS
* MongoDB server
* Firebase web app, bucket, service account, and user account
* Photon Cloud Voice and Realtime apps
* Optional: Twilio (2FA), Cloudflare Turnstile (captcha),
  [ExceptionRetrievalServer](https://github.com/SubsurfaceStudios/ExceptionRetrievalServer)

# Setup
* `git clone https://github.com/kfarwell/CompensationAPI`
* `cd CompensationAPI`
* `git submodule update --init`
* `npm install`
* Copy example.config.jsonc to config.jsonc and fill it in.
* `npm start`

# Website
[compensation.subsurface.dev](https://compensation.subsurface.dev)

# Creators
We are [Subsurface Studios](https://subsurface.az-raven.com)! We are a group of independent
developers working to make better games for all. We work to test our games more rigorously,
invest more time and energy, and generally create more polished experiences than those around
us. For more information, check out https://subsurface.az-raven.com.
