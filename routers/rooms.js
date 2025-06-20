const router = require('express').Router();
const {authenticateToken, authenticateToken_optional, authenticateDeveloperToken} = require('../middleware');
const Fuse = require('fuse.js');
const express = require('express');
const { getStorage } = require('firebase-admin/storage');
const { v1 } = require('uuid');
const { auditLog, PullPlayerData } = require('../helpers');
const { default: rateLimit } = require('express-rate-limit');
const { WebSocketV2_MessageTemplate } = require('../index');

// Base URL: /api/rooms/...

/**
 * @readonly
 * @enum {string}
 */
const AuditEventType = {
    /** Logged when a player first creates a room. */
    RoomCreate: "room_created",
    /** Logged when a player creates a new subroom. */
    SubroomCreate: "subroom_created",
    /** Logged when a player deletes a subroom. */
    SubroomDelete: "subroom_deleted",
    /** Logged when a player updates the max player count of a subroom. */
    SubroomMaxPlayerUpdate: "subroom_max_players_updated",
    /** Logged when a player sets the home subroom of this room. */
    HomeSubroomSet: "home_subroom_updated",
    /** Logged when a user updates another user's role within this room. */
    UserRoleUpdate: "user_roles_updated",
    /** Logged when a player creates a new role. */
    RoleCreated: "role_created",
    /** Logged when a user updates the permissions of a role. */
    RolePermissionsUpdate: "role_permissions_updated",
    /** Logged when a player deletes a role. */
    RoleDeleted: "role_deleted",
    /** Logged when a user updates the tags for this room. */
    TagUpdate: "tags_updated",
    /** Logged when a user updates the description for this room. */
    DescriptionUpdate: "description_updated",
    /** Logged when a user creates a new changeset. */
    ChangesetCreation: "changeset_created",
    /** Logged when a user changes the public version of this room. */
    PublicVersionUpdate: "public_version_updated",
    /** Logged when a user changes the content flags on this room. */
    ContentFlagsUpdate: "content_flags_updated",
    /** MAJOR - Logged when a developer suspends this room, locking everyone out until moderation review concludes. */
    RoomSuspendedByDeveloper: "room_suspended",
    /** MAJOR - Logged when a developer terminates this room, permanently locking it from all users. */
    RoomTerminatedByDeveloper: "room_terminated",
    /** MAJOR - Logged when a developer completely wipes this room from the database forever, usually for legal reasons. */
    RoomTerminatedByDeveloperForIllegalContent: "room_terminated_for_illegal_content"
};

// eslint-disable-next-line no-unused-vars
const roomTemplate = {
    _id: "undefined_room",
    name: "undefined_room",
    description: "This room is a blank canvas. Make it into whatever you like!",
    creator_id: "16",
    tags: [],
    created_at: new Date(0),
    homeSubroomId: "home",
    subrooms: {},
    userPermissions: {},
    rolePermissions: {
        everyone: {
            viewAndJoin: false,
            createVersions: false,
            setPublicVersion: false
        }
    },
    cover_image_id: "2"
};

router.use(express.text({
    'limit': '50MB',
    'inflate': true
}));

router.route("/room/:room_id/info")
    .get(authenticateToken_optional, async (req, res) => {
        try {
            const {room_id} = req.params;

            const {mongoClient} = require('../index');
            const db = mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

            const room_collection = db.collection("rooms");

            const room = await room_collection.findOne({_id: {$eq: room_id, $exists: true}});
            if(room === null) return res.status(404).send({message: "room_not_found"});

            const userPermissions = room.userPermissions;
            const rolePermissions = room.rolePermissions;

            if(typeof req.user != 'undefined') {
                const role = Object.keys(userPermissions).includes(req.user.id) ? userPermissions[req.user.id] : "everyone";
                const permissions = rolePermissions[role];

                if(!permissions.viewAndJoin && req.user.id !== room.creator_id) return res.status(403).send({message: "invalid_permissions"});
            } else {
                const permissions = rolePermissions.everyone;

                if(!permissions.viewAndJoin) return res.status(403).send({message: "invalid_permissions"});
            }

            // refetch the room using projection so we're not exposing permissions and subroom data to the user
            const room_visible = await room_collection.findOne({_id: {$eq: room_id, $exists: true}}, {projection: {_id: 1, name: 1, description: 1, creator_id: 1, tags: 1, created_at: 1, visits: 1, homeSubroomId: 1, cover_image_id: 1, contentFlags: 1}});
            return res.status(200).json(room_visible);
        } catch (ex) {
            res.sendStatus(500);
            throw ex;
        }
    });

const download_limit = rateLimit({
    'windowMs': 60 * 10 * 1000,
    'max': 10
});

router.route("/room/:room_id/subrooms/:subroom_id/versions/:version_id/download")
    .get(authenticateToken, download_limit, async (req, res) => {
        try {
            var {room_id, subroom_id, version_id} = req.params;

            const {mongoClient: client} = require('../index');
            const db = client.db(process.env.MONGOOSE_DATABASE_NAME);

            const room_collection = db.collection("rooms");

            const room = await room_collection.findOne({_id: {$eq: room_id, $exists: true}});
            if(room == null) return res.status(404).send({message: "room_not_found"});
               
            if(!Object.keys(room.subrooms).includes(subroom_id)) return res.status(404).send({message: "subroom_not_found"});


            
            const subroom = room.subrooms[subroom_id];
            
            if(version_id == 'latest') version_id = subroom.publicVersionId;
            if(!subroom.versions[version_id]?.associated_file) return res.status(204).json({
                "code": "no_file_associated_with_version",
                "message": "There is no file associated with this version, so loading the room objects is unnecessary."
            });

            const storage = getStorage();
            const file = storage.bucket().file(`rooms/${room_id}/subrooms/${subroom_id}/versions/${version_id}.bin`);
            
            var arrayBuffer = await file.download();
            var buffer = Buffer.from(arrayBuffer[0].buffer);
               
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': buffer.length
            });
            return res.end(buffer);
        } catch (ex) {
            res.sendStatus(500);
            throw ex;
        }
    });

router.get("/search", authenticateToken_optional, async (req, res) => {
    const {mode, query} = req.query;
    const {mongoClient: client} = require('../index');

    const db = client.db(process.env.MONGOOSE_DATABASE_NAME);
    const rooms_collection = db.collection("rooms");

    var all = await rooms_collection.find({}, {sort: {visits: 1}}).toArray();
    all = all.filter(item => {
        const userPermissions = item.userPermissions;
        const rolePermissions = item.rolePermissions;

        if(typeof req.user != 'undefined') {
            const role = Object.keys(userPermissions).includes(req.user.id) ? userPermissions[req.user.id] : "everyone";
            const permissions = rolePermissions[role];
            return permissions.viewAndJoin || req.user.developer;
        } else {
            const permissions = rolePermissions.everyone;
            return permissions.viewAndJoin;
        }
    });


    const results = all.map(item => {
        return {
            _id: item._id,
            name: item.name,
            description: item.description,
            creator_id: item.creator_id,
            tags: item.tags,
            visits: item.visits,
            created_at: item.created_at,
            cover_image_id: item.cover_image_id,
            contentFlags: item.contentFlags
        };
    });

    switch(mode) {
    case "search":
        if (!query || query.trim() === "") {
            return res.status(200).json(results);
        }
        var fuse = new Fuse(results, {
            includeScore: false,
            keys: ["name"],
        });
        var searchResults = fuse.search(query);

        return res.status(200).json(searchResults.map(item => item.item));
    case "originals":
        return res.status(200).json(results.filter(room => room.creator_id === "0"));
    case "most-visited":
        return res.status(200).json(results);
    case "mine":
        return res.status(200).json(results.filter(room => room.creator_id === req.user.id));
    default:
        return res.status(400).json({code: "invalid_mode"});
    }
});

router.put('/room/:id/subrooms/:subroom_id/versions/new', authenticateToken, requiresRoomPermission("createVersions"), async (req, res) => {
    try {
        const {id, subroom_id} = req.params;
        const input_metadata = req.body;

        // Validate metadata & assign ID.
        var decoupled_metadata = {
            baseSceneIndex: 9,
            spawn: {
                position: {
                    x: 0,
                    y: 0,
                    z: 0
                },
                rotation: {
                    x: 0,
                    y: 0,
                    z: 0,
                    w: 1
                }
            },
            shortHandCommitMessage: "No Message",
            longHandCommitMessage: "No Description",
            author: "1",
            collaborators: [],
            associated_file: false
        };

        // baseSceneIndex
        if(typeof input_metadata.baseSceneIndex == 'number') decoupled_metadata.baseSceneIndex = input_metadata.baseSceneIndex;
        // Validate spawn location 
        // WARNING: actually good comments coming up
        if(
            !( // NOT
                typeof input_metadata.spawn == 'object' &&                      // Top level object
                typeof input_metadata.spawn?.position == 'object' &&            // Level 2 - Position
                typeof input_metadata.spawn?.rotation == 'object' &&            // Level 2 - Rotation

                typeof input_metadata.spawn?.position?.x == 'number' &&         // Level 3 - X Coordinate
                typeof input_metadata.spawn?.position?.y == 'number' &&         // Level 3 - Y Coordinate
                typeof input_metadata.spawn?.position?.z == 'number' &&         // Level 3 - Z Coordinate

                typeof input_metadata.spawn?.rotation?.x == 'number' &&         // Level 3 - X Quaternion Component
                typeof input_metadata.spawn?.rotation?.y == 'number' &&         // Level 3 - Y Quaternion Component
                typeof input_metadata.spawn?.rotation?.z == 'number' &&         // Level 3 - Z Quaternion Component
                typeof input_metadata.spawn?.rotation?.w == 'number'            // Level 3 - W Quaternion Component
            )
        ) return res.status(400).json({
            "code": "invalid_metadata",
            "message": "The `spawn` parameter of your version metadata is not specified or is invalid."
        });

        // shortHandCommitMessage
        if(typeof input_metadata.shortHandCommitMessage == 'string') decoupled_metadata.shortHandCommitMessage = input_metadata.shortHandCommitMessage;
        
        // longHandCommitMessage
        if(typeof input_metadata.longHandCommitMessage == 'string') decoupled_metadata.longHandCommitMessage = input_metadata.longHandCommitMessage;

        // author
        decoupled_metadata.author = req.user.id;
        // collaborators
        if(!Array.isArray(input_metadata.collaborators)) return res.status(400).json({
            "code": "invalid_metadata",
            "message": "The `collaborators` parameter of your version metadata is not specified or is invalid."
        });

        const collection = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME).collection('rooms');
        const room = await collection.findOne({_id: {$eq: id, $exists: true}});

        if(!Object.keys(room.subrooms).includes(subroom_id)) return res.status(404).json({
            "code": "nonexistent_subroom",
            "message": "No subroom found with specified ID."
        });

        var updateFilter = {$push: {}};
        updateFilter.$push[`subrooms.${subroom_id}.versions`] = decoupled_metadata;

        await collection.updateOne({ _id: { $eq: id, $exists: true } }, updateFilter);
        
        await roomAuditLog(id, req.user.id, {
            type: AuditEventType.ChangesetCreation
        });

        return res.status(200).json({
            "code": "success",
            "message": "Operation succeeded.",
            "id": room.subrooms[subroom_id].versions.length.toString()
        });
    } catch (ex) {
        res.status(500).json({
            "code": "internal_error",
            "message": "An internal server error occured, and the operation failed. Please contact Support if the issue persists."
        });
        throw ex;
    }
});
router.post('/room/:id/subrooms/:subroom_id/versions/:version_id/associate-data', authenticateToken, requiresRoomPermission("createVersions"), async (req, res) => {
    try {
        var {id, subroom_id, version_id} = req.params;
        const base_64_data = req.body;

        version_id = parseInt(version_id);
        if(isNaN(version_id)) return res.status(400).json({
            "code": "invalid_parameter",
            "message": "Parameter `version` is invalid, must be parsable as Integer."
        });

        const collection = require('../index')
            .mongoClient
            .db(process.env.MONGOOSE_DATABASE_NAME)
            .collection('rooms');

        const room = await collection.findOne({_id: {$eq: id, $exists: true}});
        
        if(!Object.keys(room.subrooms).includes(subroom_id)) return res.status(403).json({
            "code": "nonexistent_subroom",
            "message": "That subroom does not exist."
        });

        const subroom = room.subrooms[subroom_id];
        if(subroom.versions.length - 1 < version_id) return res.status(404).json({
            "code": "version_not_found",
            "message": "No version of this room exists with that ID."
        });

        if(subroom.versions[version_id].associated_file) return res.status(400).json({
            "code": "file_already_associated",
            "message": "There is already a file associated with this version. Try making a new one."
        });

        var buffer;
        try {
            buffer = Buffer.from(base_64_data, 'base64');
        } catch {
            return res.status(400).json({
                "code": "binary_data_invalid",
                "message": "Your byte array could not be parsed into a valid ArrayBuffer."
            });
        }

        const storage = getStorage();
        var file = storage
            .bucket()
            .file(`rooms/${id}/subrooms/${subroom_id}/versions/${version_id}.bin`)
            .createWriteStream({
                'contentType': "application/octet-stream"
            });

        file.end(buffer);

        var updateFilter = {$set: {}};
        updateFilter.$set[`subrooms.${subroom_id}.versions.${version_id}.associated_file`] = true;

        await collection.updateOne({_id: {$eq: id, $exists: true}}, updateFilter);

        return res.status(200).json({
            "code": "success",
            "message": "Operation successful."
        });
    } catch (ex) {
        res.status(500).json({
            "code": "internal_error",
            "message": "An internal server error occured and the operation failed. If the issue persists, contact Support."
        });
        throw ex;
    }
});
router.post('/room/:id/subrooms/:subroom_id/versions/public', authenticateToken, requiresRoomPermission("setPublicVersion"), async (req, res) => {
    try {
        const {id, subroom_id} = req.params;
        const {id: version_id} = req.body;
        if(typeof version_id != 'string') return res.status(400).json({
            "code": "invalid_input",
            "message": "Parameter `new_id` is unset. Please specify a new publicVersionId."
        });

        const client = require('../index').mongoClient;
        const room = await client.db(process.env.MONGOOSE_DATABASE_NAME).collection('rooms').findOne({_id: {$eq: id, $exists: true}});
        if(room == null) return res.status(404).json({
            "code": "room_not_found",
            "message": "That room does not exist."
        });
        if(!Object.keys(room.subrooms).includes(subroom_id)) return res.status(404).json({
            "code": "nonexistent_subroom",
            "message": "That subroom does not exist."
        });
        if(room.subrooms[subroom_id].versions.length <= parseInt(version_id)) return res.status(400).json({
            "code": "nonexistent_version",
            "message": "There is no version of this room associated with that ID."
        });

        const str = `subrooms.${subroom_id}.publicVersionId`;

        var setFilter = {};
        setFilter[str] = version_id;


        await client.db(process.env.MONGOOSE_DATABASE_NAME)
            .collection('rooms')
            .updateOne(
                {_id: {$eq: id, $exists: true}},
                {$set: setFilter}
        );
        
        await roomAuditLog(id, req.user.id, {
            type: AuditEventType.PublicVersionUpdate,
            previous_value: room.subrooms[subroom_id].publicVersionId,
            new_value: version_id
        });
        
        return res.status(200).json({
            "code": "success",
            "message": "Operation successful"
        });
    } catch (ex) {
        res.status(500).json({
            "code": "internal_error",
            "message": "An internal error occured while processing your request. If the issue persists, please contact the server admin."
        });
        throw ex;
    }
});

router.post('/room/:id/tags', authenticateToken, requiresRoomPermission("manageTags"), async (req, res) => {
    try {
        const { tags } = req.body;
        const { id } = req.params;

        if (typeof tags != 'object' || !Array.isArray(tags)) return res.status(400).json({
            code: "invalid_input",
            message: "Cannot set tags of room to anything other than a string[]."
        });

        for (let index = 0; index < tags.length; index++) {
            if (typeof tags[index] != 'string') return res.status(400).json({
                code: "invalid_input",
                message: "Cannot set tags of room to anything other than a string[]."
            });
        }

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        await db.collection('rooms')
            .updateOne(
                {
                    _id: {
                        $exists: true,
                        $eq: id
                    }
                },
                {
                    '$set': {
                        "tags": tags
                    }
                }
        );
        
        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we could not process your request."
        });
        throw ex;
    }
});

router.post('/room/:id/content_flags', authenticateToken, requiresRoomPermission("manageContentFlags"), async (req, res) => {
    try {
        const { flags } = req.body;
        const { id } = req.params;

        if (typeof flags != 'object' || Array.isArray(flags)) return res.status(400).json({
            code: "invalid_input",
            message: "Cannot set flags of room to anything other than a Dictionary<string, string>."
        });

        for (let index = 0; index < Object.keys(flags).length; index++) {
            if (typeof flags[Object.keys(flags)[index]] != 'string') return res.status(400).json({
                code: "invalid_input",
                message: "Cannot set flags of room to anything other than a Dictionary<string, string>."
            });
        }

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        await roomAuditLog(
            id,
            req.user.id,
            {
                type: AuditEventType.ContentFlagsUpdate,
                previous_value:
                    await db.collection('rooms').findOne({
                        _id: { $exists: true, $eq: id }
                    }).contentFlags,
                new_value: flags
            }
        );

        await db.collection('rooms')
            .updateOne(
                {
                    _id: {
                        $exists: true,
                        $eq: id
                    }
                },
                {
                    '$set': {
                        "contentFlags": flags
                    }
                }
        );

        
        
        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we could not process your request."
        });
        throw ex;
    }
});

router.post('/room/:id/moderation-suspend', authenticateDeveloperToken, async (req, res) => {
    try {
        const { id: room_id } = req.params;
        const { note } = req.body;

        if (note && typeof note != 'string') return res.status(400).json({
            code: "invalid_input",
            message: "Note must be either unspecified or a string."
        });

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
        const collection = db.collection('rooms');

        const room = await collection.findOne({
            _id: {
                $exists: true,
                $eq: room_id
            }
        });

        if (!room) return res.status(404).json({
            code: "room_not_found",
            message: "Could not locate that room. Has another developer already terminated it?"
        });

        await collection.updateOne(
            {
                _id: {
                    $exists: true,
                    $eq: room_id
                }
            },
            {
                $set: {
                    "userPermissions": {},
                    "rolePermissions.everyone.viewAndJoin": false,
                    "rolePermissions.everyone.managePermissions": false,
                    "description": "This room has been suspended by the Compensation server moderation team for possible violations of our community standards.",
                }
            }
        );

        roomAuditLog(room_id, req.user.id, {
            'type': AuditEventType.RoomSuspendedByDeveloper,
            'previous_value': null,
            'new_value': null,
            'note': note
        });

        auditLog(`!! MODERATION ACTION !! - User ${req.user.id} **suspended** room ${room_id}`);

        const players = db.collection("accounts");

        /** @type {string} */
        var roomname = room.name;

        while (roomname.indexOf("</noparse>") >= 0) {
            roomname = roomname.replace("</noparse>", "<\\\\noparse>");
        }

        await players.updateOne(
            {
                _id: {
                    $eq: room.creator_id,
                    $exists: true
                }
            },
            {
                $push: {
                    "notifications": {
                        template: "room_suspension_notice",
                        parameters: {
                            "headerText": "<smallcaps><color=red>Urgent Moderation Notice",
                            "bodyText": `We regret to inform you that your room <noparse>"${roomname}"</noparse> has been <color=yellow>suspended</color> by the Compensation server moderation team.`
                        }
                    }
                }
            }
        );

        var send = WebSocketV2_MessageTemplate;
        send.code = "urgent_notification_recieved";
        send.data = {};
        require('./ws/WebSocketServerV2').ws_connected_clients[room.creator_id]?.socket?.send(JSON.stringify(send, null, 5));

        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we could not suspend that room."
        });
        throw ex;
    }
});

router.post("/room/:id/moderation-terminate", authenticateDeveloperToken, async (req, res) => {
    try {
        const { id: room_id } = req.params;
        const { note } = req.body;
        const { permanent } = req.query;

        if (note && typeof note != 'string') return res.status(400).json({
            code: "invalid_input",
            message: "Note must be either unspecified or a string."
        });

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
        const collection = db.collection('rooms');

        const room = await collection.findOne({
            _id: {
                $exists: true,
                $eq: room_id
            }
        });

        if (!room) return res.status(404).json({
            code: "room_not_found",
            message: "Could not locate that room. Has another developer already terminated it?"
        });

        if (permanent == "true") {
            await collection.deleteOne({
                _id: {
                    $exists: true,
                    $eq: room_id
                } 
            });

            roomAuditLog(room_id, req.user.id, {
                'type': AuditEventType.RoomTerminatedByDeveloperForIllegalContent,
                'previous_value': null,
                'new_value': null,
                'note': note
            });

            auditLog(`!! EXTREME MODERATION ACTION !! - User ${req.user.id} **terminated** room ${room_id} permanently, wiping it from the database FOREVER! This should only ever happen for legal reasons!`);

            return res.status(200).json({
                code: "success",
                message: "Room wiped entirely from database."
            });
        }

        await collection.updateOne(
            {
                _id: {
                    $exists: true,
                    $eq: room_id
                }
            },
            {
                $set: {
                    "userPermissions": {},
                    "rolePermissions": {
                        "everyone": {},
                    },
                    "description": "This room has been terminated by the Compensation server moderation team for repeated violations of our community standards.",
                }
            }
        );

        roomAuditLog(room_id, req.user.id, {
            'type': AuditEventType.RoomTerminatedByDeveloper,
            'previous_value': null,
            'new_value': null,
            'note': note
        });

        auditLog(`!! MODERATION ACTION !! - User ${req.user.id} **terminated** room ${room_id}!`);

        const players = db.collection("accounts");

        /** @type {string} */
        var roomname = room.name;

        while (roomname.indexOf("</noparse>") >= 0) {
            roomname = roomname.replace("</noparse>", "<\\\\noparse>");
        }

        await players.updateOne(
            {
                _id: {
                    $eq: room.creator_id,
                    $exists: true
                }
            },
            {
                $push: {
                    "notifications": {
                        template: "room_termination_notice",
                        parameters: {
                            "headerText": "<smallcaps><color=red>Urgent Moderation Notice",
                            "bodyText": `We regret to inform you that your room <noparse>"${roomname}"</noparse> has been <color=#FF5566>Terminated</color> by the Compensation server moderation team.`
                        }
                    }
                }
            }
        );

        var send = WebSocketV2_MessageTemplate;
        send.code = "urgent_notification_recieved";
        send.data = {};
        require('./ws/WebSocketServerV2').ws_connected_clients[room.creator_id]?.socket?.send(JSON.stringify(send, null, 5));

        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we could not suspend that room."
        });
        throw ex;
    }
});

router.post('/room/:id/description', authenticateToken, requiresRoomPermission("editDescription"), async (req, res) => {
    try {
        const { description } = req.body;
        const { id } = req.params;

        if (typeof description != 'string') return res.status(400).json({
            code: "invalid_input",
            message: "Cannot set description of room to anything other than a string."
        });

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        await db.collection('rooms')
            .updateOne(
                {
                    _id: {
                        $exists: true,
                        $eq: id
                    }
                },
                {
                    '$set': {
                        "description": description
                    }
                }
        );

        await roomAuditLog(
            id,
            req.user.id,
            {
                type: AuditEventType.DescriptionUpdate,
                previous_value:
                    await db.collection('rooms').findOne({
                        _id: { $exists: true, $eq: id }
                    }).description,
                new_value: description
            }
        );
        
        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we could not process your request."
        });
        throw ex;
    }
});

router.get('/room/:id/subrooms/list', authenticateToken, requiresRoomPermission("manageSubrooms"), async (req, res) => {
    try {
        const { id } = req.params;

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        const subrooms = (await db.collection('rooms')
            .find(
                {
                    _id: {
                        $eq: id,
                        $exists: true
                    }
                },
                {
                    'projection': {
                        'subrooms': true
                    }
                }
            ).tryNext()).subrooms;
        
        return res.status(200).json({
            code: "success",
            data: subrooms
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal server error occurred and we could not serve your request."
        });
        throw ex;
    }
});

router.get('/room/:id/my-permissions', authenticateToken, canViewRoom, async (req, res) => {
    try {
        return res.status(200).json({
            "code": "success",
            "message": "The operation succeeded.",
            "permissions": req.userRoomPermissions
        });
    } catch (ex) {
        res.status(500).json({
            "code": "internal_error",
            "message": "An internal server error occurred, preventing the operation from succeeding."
        });
        throw ex;
    }
});

router.get('/room/:id/subrooms/:subroom_id/versions', authenticateToken, requiresRoomPermission("createVersions"), async (req, res) => {
    try {
        const { subroom_id } = req.params;
        if(!Object.keys(req.room.subrooms).includes(subroom_id)) return res.status(404).json({
            "code": "nonexistent_subroom",
            "message": "No subroom on record was found with that ID."
        });

        return res.status(200).json({
            "code": "success",
            "message": "Operation successful.",
            "versions": req.room.subrooms[subroom_id].versions.map((item, index) => {
                item.id = `${index}`;
                return item;
            })
        });
    } catch (ex) {
        res.status(500).json({
            "code": "internal_error",
            "message": "An internal server error occurred, preventing the operation from succeeding."
        });
        throw ex;
    }
});

const ReportRateLimit = rateLimit({
    'max': 1,
    'windowMs': 60 * 60 * 1000
});

router.post('/room/:id/report', ReportRateLimit, authenticateToken, async (req, res) => {
    try {
        const {
            /** @type {string} */
            id
        } = req.params;

        const {
            /** @type {string} */
            reason,
            /** @type {boolean} */
            illegal_content,
            /** @type {boolean} */
            danger_of_harm
        } = req.body;

        if (
            typeof reason != 'string' ||
            typeof illegal_content != 'boolean' ||
            typeof danger_of_harm != 'boolean'
        ) return res.status(400).json({
            code: "invalid_input",
            message: "One or more parameters of your request are invalid."
        });

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
        const collection = db.collection('rooms');

        await collection.updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $push: {
                    "reports": {
                        reason: reason,
                        alleges_illegal_content: illegal_content,
                        alleges_danger_of_harm: danger_of_harm,
                        reporting_user_id: req.user.id,
                        time: Date.now()
                    }
                }
            }
        );

        const data = await collection.findOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            }
        );

        if (illegal_content && danger_of_harm) {
            auditLog(
                `
                !! EMERGENCY !!
                <@&812976292634427394>
                A player (ID ${req.user.id}) has submitted a report against room '${data.name}' (ID ${data._id})!
                Reason: 
                \`${reason}\`
                HOWEVER
                The user also indicated that this room may contain both ***ILLEGAL CONTENT*** and an ***IMMEDIATE THREAT TO HUMAN LIFE***!
                It is absolutely paramount that this room is immediately investigated! Serious physical and legal consequences may result if it is not!
                Please remember it may be necessary to inform law enforcement of this incident, for that reason it is ***essential*** that
                you keep a detailed log of your actions on this room and against this user. ***DO NOT DELETE ANY LOGS!***
                `, true);
        } else if (illegal_content) {
            auditLog(
                `
                !! EMERGENCY !!
                <@&812976292634427394>
                A player (ID ${req.user.id}) has submitted a report against room '${data.name}' (ID ${data._id})!
                Reason: 
                \`${reason}\`
                HOWEVER
                The user also indicated that this room may contain ***ILLEGAL CONTENT!***
                It is absolutely paramount that this room is immediately investigated! Serious legal consequences may result if it is not!
                Please remember it may be necessary to inform law enforcement of this incident, for that reason it is ***essential*** that
                you keep a detailed log of your actions on this room and against this user. ***DO NOT DELETE ANY LOGS!***
                `, true);
        } else if (danger_of_harm) {
            auditLog(
                `
                !! EMERGENCY !!
                <@&812976292634427394>
                A player (ID ${req.user.id}) has submitted a report against room '${data.name}' (ID ${data._id})!
                Reason: 
                \`${reason}\`
                HOWEVER
                The user also indicated that this room may pose an ***IMMEDIATE THREAT TO HUMAN LIFE!***
                It is absolutely paramount that this room is immediately investigated! Serious physical consequences may result if it is not!
                Please remember it may be necessary to inform law enforcement of this incident, for that reason it is ***essential*** that
                you keep a detailed log of your actions on this room and against this user. ***DO NOT DELETE ANY LOGS!***
                `, true);
        } else {
            auditLog(
                `
                !! MODERATION ACTION !!
                A player (ID ${req.user.id}) has submitted a report against room '${data.name}' (ID ${data._id}).
                Reason:
                \`${reason}\`
                Please investigate at your soonest convenience.
                `, true);
        }

        return res.status(200).json({
            code: "success",
            message: "Successfully reported room."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we could not perform that operation."
        });
        throw ex;
    }
});

router.post('/new', authenticateToken, async (req, res) => {
    try {
        const { name } = req.body;

        const coll = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME).collection("rooms");

        
        if(typeof name != 'string') return res.status(400).json({
            code: "unspecified_parameter",
            message: "You did not specify the parameter 'name' in your request body."
        });

        const predecessor = await coll.findOne(
            {
                _id: { $exists: true },
                creator_id: { $exists: true, $eq: req.user.id },
                name: { $exists: true, $eq: name}
            }
        );

        if (predecessor != null) return res.status(400).json({
            code: "room_already_exists",
            message: "You have already created a room with that name."
        });

        let userPermissions = {};
        userPermissions[req.user.id] = "owner";

        const room = {
            _id: v1(),
            name: name,
            description: "An empty room.",
            creator_id: req.user.id,
            tags: ["community", "custom room"],
            created_at: Date.now(),
            visits: 0,
            subrooms: {
                home: {
                    publicVersionId: 0,
                    maxPlayers: 20,
                    versions: [
                        {
                            baseSceneIndex: 15,
                            spawn: {
                                position: {
                                    x: 0,
                                    y: 0,
                                    z: 0,
                                },
                                rotation: {
                                    x: 0,
                                    y: 0,
                                    z: 0,
                                    w: 0
                                }
                            },
                            shortHandCommitMessage: "Initial Commit",
                            longHandCommitMessage: "Initial Commit - Auto-Generated for your convenience.",
                            author: req.user.id,
                            collaborators: [],
                            associated_file: false
                        }
                    ]
                }
            },
            homeSubroomId: "home",
            rolePermissions: {
                everyone: {
                    viewAndJoin: false,
                    createVersions: false,
                    setPublicVersion: false,
                    viewSettings: false,
                    viewPermissions: false,
                    managePermissions: false,
                    useCreationTool: false
                },
                owner: {
                    viewAndJoin: true,
                    createVersions: true,
                    setPublicVersion: true,
                    viewSettings: true,
                    viewPermissions: true,
                    managePermissions: true,
                    useCreationTool: true
                }
            },
            userPermissions: userPermissions,
            cover_image_id: "2",
            contentFlags: {}
        };

        await coll.insertOne(room);
        await roomAuditLog(
            room._id,
            req.user.id,
            {
                type: AuditEventType.RoomCreate,
                new_value: name
            }
        );

        auditLog(`User ${req.user.id} created new room with ID ${room._id} and name ${name}.`);
        
        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_server_error",
            message: "An internal server error occurred and we were unable to process your request."
        });
    }
});

router.put('/room/:id/roles/new', authenticateToken, requiresRoomPermission("managePermissions"), async (req, res) => {
    try {
        const {
            /** @type {string} */
            id
        } = req.params;
        const {
            /** @type {string} */
            name
        } = req.body;

        if (typeof name != 'string') return res.status(400).json({
            code: "invalid_input",
            message: "Body field 'name' must be a string."
        });

        const collection = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME).collection('rooms');

        if (["owner", "everyone"].includes(name)) return res.status(400).json({
            code: "invalid_input",
            message: "Cannot create a role with a reserved name like 'owner' or 'everyone'."
        });

        const room = await collection.findOne({
            _id: {
                $eq: id,
                $exists: true
            }
        });
        
        if (Object.keys(room.rolePermissions).includes(name)) return res.status(400).json({
            code: "invalid_input",
            message: "Cannot create a role with the same name as one that already exists."
        });

        let $set = {};
        $set[`rolePermissions.${name}`] = {};

        await collection.updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $set: $set
            }
        );

        await roomAuditLog(id, req.user.id, {
            'type': AuditEventType.RoleCreated,
            'previous_value': null,
            'new_value': name,
            'note': null
        });

        return res.status(200).json({
            code: "success",
            message: "Successfully created role."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we could not serve your request."
        });
        throw ex;
    }
});

router.get('/room/:id/permissions', authenticateToken, requiresRoomPermission("viewPermissions"), async (req, res) => {
    try {
        const { id } = req.params;

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        const room = await db.collection('rooms').findOne({
            _id: {
                $eq: id,
                $exists: true
            }
        });

        delete room.rolePermissions.owner; // The owner role can't be mutated, so there's no reason to display it.

        res.status(200).json({
            code: "success",
            message: "The operation was successful.",
            users: room.userPermissions,
            roles: room.rolePermissions
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we couldn't serve your request."
        });
        throw ex;
    }
});

router.post("/room/:id/roles/:role_name/update", authenticateToken, requiresRoomPermission("managePermissions"), async (req, res) => {
    try {
        const {
            /** @type {string} */
            id,
            /** @type {string} */
            role_name
        } = req.params;

        if (role_name.includes("__proto__")) return res.status(400).json({
            code: "invalid_input",
            message: "Possible prototype pollution attack detected."
        });

        const {
            /** @type {Object.<string, boolean>} */
            permissions
        } = req.body;

        if (role_name == "owner") return res.status(400).json({
            code: "access_denied",
            message: "You cannot edit the permissions of the 'owner' role."
        });

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
        const collection = db.collection('rooms');

        const room = await collection.findOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            }
        );

        if (!room.rolePermissions[role_name]) return res.status(404).json({
            code: "not_found",
            message: "No role with that name exists."
        });

        for (const key in permissions) {
            if (Object.hasOwnProperty.call(permissions, key)) {
                const element = permissions[key];
                if (!req.userRoomPermissions[key] && req.userRoomRole != "owner" && !req.user.developer) return res.status(400).json({
                    code: "access_denied",
                    message: "You cannot manage permissions you don't have."
                });
                if (key.includes("__proto__")) return res.status(400).json({
                    code: "invalid_input",
                    message: "Possible prototype pollution attack detected."
                });
                if (typeof element != 'boolean') return res.status(400).json({
                    code: "invalid_input",
                    message: `All values must be booleans. (permission \`${key}\`)`
                });

                room.rolePermissions[role_name][key] = element;
            }
        }

        await collection.updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $set: {
                    rolePermissions: room.rolePermissions
                }
            }
        );

        const keys = Object.keys(room.userPermissions);

        await roomAuditLog(id, req.user.id, {
            'previous_value': req.room.rolePermissions[role_name],
            'new_value': room.rolePermissions[role_name],
            'type': AuditEventType.RolePermissionsUpdate,
            'note': null
        });

        res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });

        for (let i = 0; i < keys.length; i++) {
            if (room.userPermissions[keys[i]] != role_name) continue;

            require('./ws/WebSocketServerV2').ws_connected_clients[keys[i]]?.socket.emit('permission-update', id);
        }
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we could not serve your request."
        });
        throw ex;
    }
});

router.post("/room/:id/roles/:role_name/delete", authenticateToken, requiresRoomPermission("managePermissions"), async (req, res) => {
    try {
        const { id, role_name } = req.params;

        // Reserved role names
        if (["owner", "everyone"].includes(role_name)) return res.status(400).json({
            code: "invalid_input",
            message: "You cannot delete a reserved role. (i.e 'owner' or 'everyone')"
        });

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
        const collection = db.collection('rooms');

        var $unset = {};
        $unset[`rolePermissions.${role_name}`] = true;

        const room = await collection.findOne({
            _id: {
                $eq: id,
                $exists: true
            }
        });

        /**
         * @type {Object.<string, boolean}
         */
        var $set = {};
        /**
         * @type {string[]}
         */
        var users = [];

        const keys = Object.keys(room.userPermissions);
        for (let i = 0; i < keys.length; i++) {
            const role = keys[i];
            if (role != role_name) continue;
            $set[`userPermissions.${keys[i]}`] = "everyone";
            users.push(keys[i]);
        }

        await collection.updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $unset: $unset,
                $set: $set
            }
        );

        await roomAuditLog(id, req.user.id, {
            'type': AuditEventType.RoleDeleted,
            'previous_value': room.rolePermissions[role_name],
            'new_value': null,
            'note': null
        });

        for (let i = 0; i < users.length; i++) {
            const uid = users[i];
            require('./ws/WebSocketServerV2').ws_connected_clients[uid]?.socket.emit('permission-update');
        }

        res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal server error occurred and we couldn't serve your request."
        });
    }
});

router.post("/room/:id/user/:user_id/set-role/:role_name", authenticateToken, requiresRoomPermission("managePermissions"), async (req, res) => {
    try {
        const { id, user_id, role_name } = req.params;

        if (role_name == "owner") return res.status(403).json({
            code: "access_denied",
            message: "The 'owner' role cannot be manually assigned. Contact support if you're trying to transfer a room."
        });

        if (user_id == req.user.id) return res.status(403).json({
            code: "access_denied",
            message: "You cannot set your own role."
        });

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
        
        const room = await db.collection('rooms').findOne({
            _id: {
                $eq: id,
                $exists: true
            }
        });

        if (user_id == room.creator_id) return res.status(403).json({
            code: "access_denied",
            message: "You cannot set the role of the Room Creator."
        });

        const current_role = room.userPermissions[user_id] ?? "everyone";
        
        if (current_role == "owner") return res.status(403).json({
            code: "access_denied",
            message: "You cannot set the role of the Room Owner."
        });

        const update = {};

        if (role_name == "everyone") {
            update.$unset = {};
            update.$unset[`userPermissions.${user_id}`] = true;
        } else {
            update.$set = {};
            update.$set[`userPermissions.${user_id}`] = role_name;
        }

        await db.collection('rooms').updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            update
        );

        require('./ws/WebSocketServerV2').ws_connected_clients[user_id]?.socket.emit('permission-update', id);

        await roomAuditLog(id, req.user.id, {
            'type': AuditEventType.UserRoleUpdate,
            'previous_value': current_role,
            'new_value': role_name,
            'note': null
        });

        res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we couldn't serve your request."
        });
        throw ex;
    }
});

router.post("/room/:id/cover-image/set/:image_id", authenticateToken, requiresRoomPermission("setRoomPhoto"), async (req, res) => {
    try {
        const {
            id,
            image_id
        } = req.params;

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
        const image_collection = db.collection('images');

        const image = await image_collection.findOne(
            {
                _id: {
                    $eq: parseInt(image_id),
                    $exists: true
                }
            }
        );

        if (image == null) return res.status(404).json({
            code: "not_found",
            message: "No image exists with that ID!"
        });

        if (image.takenInRoomId != id) return res.status(400).json({
            code: "invalid_input",
            message: "That image was not taken in this room!"
        });

        await db.collection('rooms').updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $set: {
                    "cover_image_id": image_id
                }
            }
        );

        res.status(200).json({
            code: "success",
            message: "Successfully set room image!"
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we couldn't process your request."
        });
        throw ex;
    }
});

router.get("/room/:id/verify-subroom-link/:to", authenticateToken, canViewRoom, async (req, res) => {
    try {
        const { id, to } = req.params;

        const room = await require('../index')
            .mongoClient
            .db(process.env.MONGOOSE_DATABASE_NAME)
            .collection('rooms')
            .findOne({
                _id: {
                    $eq: id,
                    $exists: true
                }
            });
        
        if (!room.subrooms[to])
            return res.status(404).json({
                code: "not_found",
                message: "No subroom with that ID exists!",
                valid: false
            });
        else return res.status(200).json({
            code: "success",
            message: "This subroom link is valid.",
            valid: true
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal server error occurred while processing your request.",
            valid: false
        });
        throw ex;
    }
});

router.get("/all-permissions", async (req, res) => {
    return res.status(200).json({
        "viewAndJoin": 
            "Can players view information about this room or join?",
        "createVersions": 
            "Can players save this room?",
        "setPublicVersion": 
            "Can players set the version of the room that is loaded by default?",
        "viewSettings": 
            "Can players view the settings of this room at all?",
        "viewPermissions": 
            "Can players view the permissions & roles of all users?",
        "managePermissions": 
            "Can players edit the permissions & roles of all users?",
        "useCreationTool": 
            "Can players use their Creation Tool?",
        "kickPlayers": 
            "Can players kick other players?",
        "mutePlayers": 
            "Can players mute other players?",
        "manageSubrooms":
            "Can players update and create subrooms on this room?",
        "deleteSubrooms":
            "Can players delete subrooms on this room?",
        "editDescription":
            "Can players edit the description of this room?",
        "setHomeSubroom":
            "Can players set the home subroom of this room?",
        "manageTags":
            "Can players edit the tags of this room?",
        "manageContentFlags": 
            "Can players edit the room's content flags?",
        "setRoomPhoto": 
            "Can players set the room's photo?",
    });
});

router.post("/room/:id/subrooms/:name/create", authenticateToken, requiresRoomPermission("manageSubrooms"), async (req, res) => {
    try {
        const { id, name } = req.params;
        const { note } = req.body;

        const room = req.room;
        
        if (typeof note != 'undefined' && typeof note != 'string') return res.status(400).json({
            code: "invalid_input",
            message: "Invalid note. Note must be either a String or undefined."
        });

        if (Object.keys(room.subrooms).includes(name)) return res.status(400).json({
            code: "invalid_input",
            message: "A subroom with that name already exists."
        });
        
        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        const $set = Object.create(null);

        $set[`subrooms.${name}`] = {
            publicVersionId: 0,
            maxPlayers: 20,
            versions: [
                {
                    baseSceneIndex: 15,
                    spawn: {
                        position: {
                            x: 0,
                            y: 0,
                            z: 0
                        },
                        rotation: {
                            x: 0,
                            y: 0,
                            z: 0,
                            w: 0
                        }
                    },
                    shortHandCommitMessage: "Initial Commit",
                    longHandCommitMessage: "Initial Commit - Auto-Generated for your convenience.",
                    author: req.user.id,
                    collaborators: [],
                    associated_file: false
                }
            ]
        };

        await db.collection('rooms').updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $set: $set
            }
        );

        await roomAuditLog(id, req.user.id, {
            'type': AuditEventType.SubroomCreate,
            'previous_value': null,
            'new_value': null,
            'note': note ? note : null
        });

        res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we couldn't serve your request."
        });
        throw ex;
    }
});

router.post("/room/:id/subrooms/:name/delete", authenticateToken, requiresRoomPermission("deleteSubrooms"), async (req, res) => {
    try {
        const { id, name } = req.params;

        if (!Object.keys(req.room.subrooms).includes(name)) return res.status(404).json({
            code: "not_found",
            message: "No role with that name exists on this room."
        });

        if (name == req.room.homeSubroomId) return res.status(400).json({
            code: "invalid_input",
            message: "You cannot delete the home subroom of a room."
        });

        var $unset = {};
        $unset[`subrooms.${name}`] = true;

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        await db.collection('rooms').updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $unset: $unset
            }
        );

        await roomAuditLog(id, req.user.id, {
            'type': AuditEventType.SubroomDelete,
            'previous_value': req.room.subrooms[name],
            'new_value': null,
            'note': null
        });

        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we couldn't serve your request."
        });
        throw ex;
    }
});

router.post("/room/:id/subrooms/:name/set-max-players/:count", authenticateToken, requiresRoomPermission("manageSubrooms"), async (req, res) => {
    try {
        const { id, name, count } = req.params;

        if (!Object.keys(req.room.subrooms).includes(name)) return res.status(404).json({
            code: "not_found",
            message: "No subroom with that name exists on this room."
        });

        if (isNaN(parseInt(count))) return res.status(400).json({
            code: "invalid_input",
            message: "Could not parse URL parameter `count` as integer."
        });

        var $set = {};

        $set[`subrooms.${name}.maxPlayers`] = parseInt(count);

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        await db.collection('rooms').updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $set: $set
            }
        );

        await roomAuditLog(id, req.user.id, {
            'type': AuditEventType.SubroomMaxPlayerUpdate,
            'previous_value': req.room.subrooms[name].maxPlayers,
            'new_value': parseInt(count),
            'note': null
        });

        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal error occurred and we couldn't process your request."
        });
        throw ex;
    }
});

router.post("/room/:id/set-home-subroom/:name", authenticateToken, requiresRoomPermission("setHomeSubroom"), async (req, res) => {
    try {
        const { id, name } = req.params;

        if (!Object.keys(req.room.subrooms).includes(name)) return res.status(404).json({
            code: "not_found",
            message: "No subroom with that name exists on this room."
        });

        const db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        await db.collection('rooms').updateOne(
            {
                _id: {
                    $eq: id,
                    $exists: true
                }
            },
            {
                $set: {
                    homeSubroomId: name
                }
            }
        );

        await roomAuditLog(id, req.user.id, {
            'type': AuditEventType.HomeSubroomSet,
            'previous_value': req.room.homeSubroomId,
            'new_value': name,
            'note': null
        });

        return res.status(200).json({
            code: "success",
            message: "The operation was successful."
        });
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal server error occurred and we couldn't serve your request."
        });
        throw ex;
    }
});

// TODO: This is a stud implementation, so far just
//       returning HTTP 501 Not Implemented. This is
//       mostly just to reserve the name.
router.put("/room/:id/subroom/:name/upload-bundle", authenticateToken, requiresRoomPermission("manageSubrooms"), async (req, res) => {
    return res.status(501).json({
        code: "not_implemented",
        message: "This feature is not yet implemented."
    });
});

// TODO: This is also a stud implementation, so far just
//       returning HTTP 501 Not Implemented. This will
//       likely be implemented shortly.
router.get("/room/:id/subroom/:name/download-bundle", authenticateToken, requiresRoomPermission("viewAndJoin"), async (req, res) => {
    return res.status(501).json({
        code: "not_implemented",
        message: "This feature is not yet implemented."
    });
});

async function canViewRoom(req, res, next) {
    // Input validation
    const client = require('../index').mongoClient;
    const {id} = req.params;
    if(typeof id != 'string') return res.status(404).json({
        "code": "room_not_found",
        "message": "You did not specify a room."
    });

    // Fetch room
    var room = await client
        .db(process.env.MONGOOSE_DATABASE_NAME)
        .collection('rooms')
        .findOne({_id: {$eq: id, $exists: true}});
    if(room == null) return res.status(404).json({
        "code": "room_not_found",
        "message": "You did not specify a room."
    });

    const userPermissions = room.userPermissions;
    const rolePermissions = room.rolePermissions;

    const role = Object.keys(userPermissions).includes(req.user.id) ? userPermissions[req.user.id] : "everyone";
    const canView = rolePermissions[role].viewAndJoin || req.user.developer;

    if(!canView) {
        return res.status(404).json({
            "code": "room_not_found",
            "message": "You did not specify a room."
        });
    }

    req.room = room;
    req.userRoomRole = room.userPermissions;
    req.userRoomPermissions = rolePermissions[role];
    next();
}

function requiresRoomPermission(permission) {
    return async (req, res, next) => {
        // Input validation
        const client = require('../index').mongoClient;
        const {id} = req.params;
        if(typeof id != 'string') return res.status(404).json({
            "code": "room_not_found",
            "message": "You did not specify a room."
        });
    
        // Fetch room
        var room = await client
            .db(process.env.MONGOOSE_DATABASE_NAME)
            .collection('rooms')
            .findOne({_id: {$eq: id, $exists: true}});
        if(room == null) return res.status(404).json({
            "code": "room_not_found",
            "message": "Room not found."
        });
    
        const userPermissions = room.userPermissions;
        const rolePermissions = room.rolePermissions;
    
        const role = Object.keys(userPermissions).includes(req.user.id) ? userPermissions[req.user.id] : "everyone";
    
        if(!req.user.developer && !rolePermissions[role][permission] && role != "owner") {
            return res.status(404).json({
                "code": "room_not_found",
                "message": "Access denied."
            });
        }
    
        req.room = room;
        req.userRoomRole = room.userPermissions;
        req.userRoomPermissions = rolePermissions[role];
        next();
    };
}


// This function should have a use somewhere.
// eslint-disable-next-line no-unused-vars
async function hasPermission(user_id, room_id, permission) {
    const client = require('../index').mongoClient;
    var room = await client
        .db(process.env.MONGOOSE_DATABASE_NAME)
        .collection('rooms')
        .findOne({ _id: { $eq: room_id, $exists: true } });
    
    const user = await PullPlayerData(user_id);
    if (user.private.availableTags.includes("Developer")) return true;

    const userPermissions = room.userPermissions;
    const rolePermissions = room.rolePermissions;

    const assigned_role = Object.keys(userPermissions).includes(user_id) ? userPermissions[user_id] : "everyone";
    const role = rolePermissions[assigned_role];
    return role[permission];
}

/**
 * @async
 * @function roomAuditLog
 * @param {string} room_id - The room ID to apply the event to.
 * @param {string} user_id - The user applying this event.
 * @param {Object} event - The audit log event to apply.
 * @param {AuditEventType} event.type - The type of event this is.
 * @param {string?} event.previous_value - The previous value of the variable changed, if applicable.
 * @param {string?} event.new_value - The new value of the variable changed, if applicable.
 * @param {string?} event.note - The note left by the user who made the change, if applicable.
 * @returns {Promise<void>}
 */
async function roomAuditLog(room_id, user_id, event) {
    const client = require('../index').mongoClient;
    const db = client.db(process.env.MONGOOSE_DATABASE_NAME);
    const collection = db.collection("room_audit");
    
    var event = {
        room_id: room_id,
        user_id: user_id,
        event_time: Date.now(),
        event_data: event
    };

    await collection.insertOne(event);
}

module.exports = {
    Router: router,
    roomAuditLog: roomAuditLog
};
