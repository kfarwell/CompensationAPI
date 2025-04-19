# Compensation Social API
This was the repository containing all API code for the Compensation Social official servers.
It has since been archived due to the official servers being shut down. If you wish to host
your own server, we recommend creating a fork of this repository and continuing from there.
  
Best of luck, and we hope you enjoy Compensation Social!

# Prerequisites
* NodeJS
* MongoDB server
* Firebase web app, bucket, service account, and user account
  * Upload a CVR room to `rooms/4b7d3810-be88-11ec-b306-43a037ec5b07/subrooms/home/versions/0.bin`
* Photon Cloud Voice and Realtime apps

# Setup
* `git clone https://github.com/kfarwell/CompensationAPI`
* `cd CompensationAPI`
* `git submodule update --init`
* `npm install`
* Copy config.json.example to config.json. Fill in your API URL, Firebase bucket URL, and Photon Cloud App IDs.
* Copy .env.example to .env. Fill in your MongoDB info, Firebase user credentials, and generate secrets.
* Copy env.js.example to env.js. Fill in your Firebase web app config.
* Put your Firebase service account key in admin.json.
* `npm start`

# Optional (TODO: document)
* Twilio 2FA
* [ExceptionRetrievalServer](https://github.com/SubsurfaceStudios/ExceptionRetrievalServer)

# Website
[compensation.subsurface.dev](https://compensation.subsurface.dev)

# Creators
We are [Subsurface Studios](https://subsurface.az-raven.com)! We are a group of independent
developers working to make better games for all. We work to test our games more rigorously,
invest more time and energy, and generally create more polished experiences than those around
us. For more information, check out https://subsurface.az-raven.com.
