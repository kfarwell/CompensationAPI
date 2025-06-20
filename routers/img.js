const router = require('express').Router();
const helpers = require('../helpers');
const middleware = require('../middleware');
const express = require('express');
// const firebaseStorage = require('firebase/storage');
const { initializeApp, cert } = require('firebase-admin/app');
const { Storage } = require('firebase-admin/storage');
const serviceAccount = require('../admin.json');

const NodeCache = require('node-cache');

const config = require('../config.json');
const { default: rateLimit } = require('express-rate-limit');

router.use(express.text({limit: config.max_image_size}));

router.use(express.urlencoded({extended: false}));

const app = initializeApp({
    credential: cert(serviceAccount),
    storageBucket: config.firebase_bucket_url
});

const imageMetadataTemplate = {
    _id: 'undefined',
    internalPathRef: '/images/undefined.jpg',
    takenBy: {
        id: '0',
        nickname: 'DEVTEST',
        username: 'devtest'
    },
    takenInRoomId: '0',
    others: [ '0' ],
    room: {
        id: '0',
        creator: '0',
        name: 'Apartment'
    },
    infoPath: '/img/0/info',
    filePath: '/img/0',
    takenOn: {
        unixTimestamp: 0,
        humanReadable: 'Thu, 01 Jan 1970'
    },
    social: {
        comments: [],
        votes: 0,
        tags: [
            'photo'
        ]
    },
    visibility: "public"
};

const uploadRateLimit = rateLimit({
    'windowMs': 3600000,
    'max': 10,
    'legacyHeaders': true,
    'standardHeaders': true
});

const fetch_rate_limit = rateLimit({
    'windowMs': 60 * 1000,
    'max': 50,
    'standardHeaders': true,
    'legacyHeaders': true
});

// 24 hour cache
const imgCache = new NodeCache({
    "deleteOnExpire": true,
    "stdTTL": 60 * 60 * 24
});

router.post("/upload", uploadRateLimit, middleware.authenticateToken, async (req, res) => {
    if(config.disable_image_upload && !req.user.developer) return res.status(409).send({"message": "Access denied - image uploads have been disabled by the system administrator.", "code": "uploads_disabled"});
    try {
        var {others, room_id, tags} = req.query;
        if(!req.headers['content-type'].startsWith('text/plain') || typeof req.body == 'undefined') return res.status(400).send("You did not send encoded photo data.");
        if(typeof room_id != 'string') return res.status(400).send("Room ID not specified.");
        if(typeof others != 'string') others = '[]';
        if(typeof tags != 'string' || !(JSON.parse(tags) instanceof Array)) tags = '[ "photo" ]';

        var timestamp = Date.now();
        var TakenByData = await helpers.PullPlayerData(req.user.id);

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
        var collection = db.collection("configuration");

        var doc = await collection.findOne({_id: 'ImageCount'});

        var MetaData = imageMetadataTemplate;
        MetaData._id = doc.count + 1;

        MetaData.takenBy.id = req.user.id;
        MetaData.takenBy.nickname = TakenByData.public.nickname;
        MetaData.takenBy.username = TakenByData.public.username;

        MetaData.takenOn.unixTimestamp = timestamp;
        MetaData.takenOn.humanReadable = new Date(timestamp).toUTCString();

        // TODO room implementation with photos

        MetaData.others = JSON.parse(others);
        MetaData.internalPathRef = `images/${MetaData._id}.jpg`;
        MetaData.infoPath = `/img/${MetaData._id}/info`;
        MetaData.filePath = `/img/${MetaData._id}`;

        MetaData.takenInRoomId = room_id;
        MetaData.room.id = room_id;

        MetaData.social.tags = JSON.parse(tags);

        if (req.query.visibility == "unlisted") MetaData.visibility = "unlisted";

        // Push metadata to MongoDB
          
        collection.updateOne({_id: 'ImageCount'}, {$set: {count: MetaData._id}});

        // Switch to the Images collection.
        collection = db.collection("images");

        collection.insertOne(MetaData);

        // Parse image
        const buff = Buffer.from(req.body, 'base64');


        // Upload image to firebase.
        const storage = new Storage(app);
        var file = storage.bucket().file(MetaData.internalPathRef).createWriteStream({
            "contentType": "image/jpg"
        });
        file.end(buff);

        helpers.auditLog(`Image with ID ${MetaData._id} has been uploaded to the API. Moderator intervention advised to ensure SFW.\nPERMALINK:\n${config.base_url}/img/${MetaData._id}`, true);

        // Finalize request
        res.status(200).send("Successfully uploaded image.");
    } catch (ex) {
        res.sendStatus(500);
        throw ex;
    }
});

router.get('/:id/embed', (req, res) => {
    // copied from /:id endpoint
    let {id} = req.params;
    if(typeof id != 'string') return res.status(400).send("You did not specify an image ID.");
    try {
        id = parseInt(id);
        if(id < 1) return res.status(400).send("Image ID is never below 0.");
    } catch {
        return res.status(400).send("Failed to parse image ID to integer, please try again with a valid URL-Encoded int.");
    }

    // template for embed page
    let html = `<!DOCTYPE html>
     <html lang="en">
     <head>
     <meta charset="UTF-8">
     <meta content="Compensation VR" property="og:title">
     <meta content="###img###" property="og:image">
     <meta content="Taken by ###nick### (@###user###) on ###time### ###tags###" property="og:description">
     <meta name="theme-color" content="#9702f4">
     <meta content="summary_large_image" name="twitter:card">
     <meta http-equiv="refresh" content="0; URL=${config.base_url}/img/${id}">
     </head>
     </html>`;

    const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
    var collection = db.collection("images");

    collection.findOne({_id: id}).then(doc => {
        if (!doc) return res.status(404).send("There's no image with this ID"); 

        // this is kind of ugly but still much better than what i had previously
        for (let [match, replacement] of Object.entries({
            '###nick###': doc.takenBy.nickname,
            '###user###': doc.takenBy.username,
            '###time###': doc.takenOn.humanReadable,
            '###tags###': doc.social.tags.map(e => '#' + e).join(' '),
            '###img###': `${config.base_url}/img/${id}`
        })) {
            // escape html to prevent xss
            replacement = replacement.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;"); // html 4 doesn't support &apos; which is why we use &39; instead
               
            html = html.replace(match, replacement);
        }

        return res.status(200).send(html);
    }, err => {
        res.status(500).send("Failed to retrieve image data.");
        throw err;
    });
});

router.get("/:id/info", async (req, res) => {
    if(config.disable_image_fetch && !req.user.developer) return res.status(500).send({"message": "Access denied - image fetching is disabled."});
    var {id} = req.params;
    if(typeof id != 'string') return res.status(400).send("You did not specify an image ID.");
    try {
        id = parseInt(id);
        if(id < 1) return res.status(400).send("Image ID is never below 0.");
        if(isNaN(id))return res.status(400).send("Failed to parse image ID to integer, please try again with a valid URL-Encoded int.");
    } catch {
        return res.status(400).send("Failed to parse image ID to integer, please try again with a valid URL-Encoded int.");
    }

    const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
    var collection = db.collection("images");

    try {
        var doc = await collection.findOne({_id: id});
        return res.status(200).json(doc);
    } catch (ex) {
        res.status(500).send("Failed to retrieve image data.");
        throw ex;
    }
});

router.get("/:id", fetch_rate_limit, async (req, res) => {
    try {
        if(config.disable_image_fetch && !req.user.developer) return res.status(500).send("Image fetching has been disabled by the system administrator.");
        // Setup of parameters
        var {id} = req.params;
        var {base64} = req.query;

        // Guard Clauses
        if(typeof id != 'string') return res.status(400).send({message:"You did not specify an image ID."});
        else try {
            id = parseInt(id);

            if(isNaN(id)) return res.status(400).send({message: "Invalid image ID specified."});
            if(id < 1) return res.status(400).send({message: "Image IDs are never below 0."});
        } catch {
            return res.status(500).send({message: "Failed to parse image ID."});
        }

        // Open database
        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        // Validate collection
        var collection = db.collection("configuration");
        const ImageCount = await collection.findOne({_id: "ImageCount"});

        if(id > ImageCount.count) return res.status(404).send({message: "The database does not contain that many images."});

        // Switch collection to image data.
        collection = db.collection("images");

        var ImageInfo = await collection.findOne({_id: {$exists: true, $eq: id}});
        if(ImageInfo == null) return res.status(404).send({code: "image_not_found", message: "That image does not exist."});

        if (typeof base64 == 'undefined' || base64 !== 'true') {
            var ImageBuffer;

            if(!imgCache.has(id) || config.disable_image_caching) {
                const storage = new Storage(app);
                storage.maxOperationRetryTime = 5 * 1000;
                storage.maxUploadRetryTime = 10 * 1000;
                const ref = storage.bucket().file(ImageInfo.internalPathRef);

                const exists = (await ref.exists())[0];

                if (!exists) return res.status(404).json({
                    code: "image_not_found",
                    message: "No image exists with that ID. Typo?"
                });

                var a = await ref.download();
                ImageBuffer = Buffer.from(a[0].buffer);
            } else {
                ImageBuffer = imgCache.get(id);
            }
               
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': ImageBuffer.length,
                'Cache-Control': 'public, max-age=604800'
            });
            res.end(ImageBuffer);

            if(!imgCache.has(id) && !config.disable_image_caching) {
                imgCache.set(id, ImageBuffer);
                console.log(`Request submitted for uncached image ${id}, cached.`);
            } else console.log(`Request submitted for cached image ${id}.`);
        } else {
            // eslint-disable-next-line no-redeclare
            var ImageBuffer;
            if(!imgCache.has(id) || config.disable_image_caching) {
                const storage = new Storage(app);
                storage.maxOperationRetryTime = 5 * 1000;
                storage.maxUploadRetryTime = 10 * 1000;
                const ref = storage.bucket().file(ImageInfo.internalPathRef);

                const exists = (await ref.exists())[0];

                if (!exists) return res.status(404).json({
                    code: "image_not_found",
                    message: "No image exists with that ID. Typo?"
                });

                ImageBuffer = Buffer.from(await ref.download()).buffer;
            } else {
                ImageBuffer = imgCache.get(id);
            }
            var ImageBase64String = Buffer.from(ImageBuffer).toString('base64');

            res.status(200).contentType('text/plain').send(ImageBase64String);
            if(!imgCache.has(id) && !config.disable_image_caching) {
                imgCache.set(id, ImageBuffer);
                console.log(`Request submitted for uncached image ${id}, cached.`);
            } else console.log(`Request submitted for cached image ${id}.`);
        }
    } catch (ex) {
        res.status(500).send("Failed to retrieve image.");
        throw ex;
    }
});

module.exports = router;
