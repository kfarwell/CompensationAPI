const router = require('express').Router();
const helpers = require('../helpers');
const middleware = require('../middleware');
const notificationTemplates = {
    invite: "invite",
    friendRequest: "friendRequest",
    messageRecieved: "messageRecieved"
};
const {WebSocketV2_MessageTemplate} = require('../index');

router.get("/imgfeed", middleware.authenticateToken_optional, async (req, res) => {
    try {
        var { count, reverse, offset, filter } = req.query;

        const client = require('../index').mongoClient;
        const db = client.db(process.env.MONGOOSE_DATABASE_NAME);
        const image_collection = db.collection("images");
          
        if (filter == "mine" && !req.user) return res.status(400).json({
            code: "not_authenticated",
            message: "You cannot use the `filter=mine` query parameter without specifying an access token."
        });

        const all_images = await image_collection.find(
            filter == "mine" ? {
                'takenBy.id': {
                    $eq: req.user.id,
                    $exists: true
                }
            } : {
                visibility: {
                    $ne: "unlisted"
                }
            }
        ).toArray();
        const image_count = all_images.length;
          
        // input validation
        try {
            count = parseInt(count);
            if(isNaN(count)) count = 50;
        } catch {
            return res.status(400).send({message: "cannot_parse_count"});
        }

        try {
            offset = parseInt(offset);
            if(isNaN(offset)) return res.status(400).send({code: "cannot_parse_offset"});
            if(image_count < offset) return res.status(400).send({code: "not_enough_images"});
        } catch {
            return res.status(400).send({code: "cannot_parse_offset"});
        }

        if(image_count < (count + offset)) count = Math.max(0, image_count - offset);

        var feed = [];
        if(typeof reverse != 'undefined' && reverse != "false") {
            for(let i = 1; i < count + 1; i++) 
                feed.push(all_images[(image_count - offset) - i]);
        } else {
            for(let i = 0; i < count; i++)
                feed.push(all_images[offset + i]);
        }

        return res.status(200).json(feed);
    } catch (ex) {
        res.status(500).json({
            code: "internal_error",
            message: "An internal server error occurred."
        });
        throw ex;
    }
});

router.get("/takenby", async (req, res) => {

    try {
        var {target, count, offset} = req.query;

        // Guard Clauses
        if(typeof target != 'string') return res.status(400).send({message: "Search target not specified in URL-Encoded parameter `target`"});

        // Parameter validation
        if(typeof count != 'string') count = 50;
        else try {
            count = parseInt(count);
        } catch {
            count = 50;
        }

        if(typeof offset != 'string') offset = 0;
        else try {
            offset = parseInt(offset);
            if(offset < 0) offset = 0;
        } catch {
            offset = 0;
        }

        // True if any value present, otherwise false.

        var db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        var collection = db.collection("images");
        var filtered_images = await collection.find({'takenBy.id': target}).toArray();

        // const filtered_images = all_images.filter(item => item.takenBy.id == target);
        const ImageCount = filtered_images.length;

        // Ensure proper count handling.
        if(count + offset > ImageCount) {
            var discrepency = ImageCount - (count + offset);
            if(count + discrepency > 0) count += discrepency;
            else return res.status(404).send({message: "There are not enough images to fulfill your request with the given offset."});
        }

        // Push image data into array and serve.
        var final_response = [];
        for (let index = offset; index < count + offset; index++) {
            final_response.push(filtered_images[index]);
        }

        return res.status(200).json(final_response);
    } catch {
        return res.sendStatus(500);
    }
});

router.get("/takenwith", async (req, res) => {

    try {
        var {target, count, offset} = req.query;

        // Guard Clauses
        if(typeof target != 'string') return res.status(400).send({message: "Search target not specified in URL-Encoded parameter `target`"});

        // Parameter validation
        if(typeof count != 'string') count = 50;
        else try {
            count = parseInt(count);
        } catch {
            count = 50;
        }

        if(typeof offset != 'string') offset = 0;
        else try {
            offset = parseInt(offset);
            if(offset < 0) offset = 0;
        } catch {
            offset = 0;
        }

        var db = require('../index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);

        var collection = db.collection("images");
        var filtered_images = await collection.find({others: {$all: [target]}}).toArray();

        const ImageCount = filtered_images.length;

        // Ensure proper count handling.
        if(count + offset > ImageCount) {
            var discrepency = ImageCount - (count + offset);
            if(count + discrepency > 0) count += discrepency;
            else return res.status(404).send({message: "There are not enough images to fulfill your request with the given offset."});
        }

        // Push image data into array and serve.
        var final_response = [];
        for (let index = offset; index < count + offset; index++) {
            final_response.push(filtered_images[index]);
        }

        return res.status(200).json(final_response);
    } catch {
        return res.sendStatus(500);
    }
});

router.post("/friend-request", middleware.authenticateToken, async (req, res) => {
    var {target} = req.body;

    var sendingData = await helpers.PullPlayerData(req.user.id);
    var recievingData = await helpers.PullPlayerData(target);

    if(await helpers.ArePlayersAnyFriendType(req.user.id, target)) return res.status(400).send("You are already friends with this player.");
    if(sendingData.private.friendRequestsSent.includes(target)) return res.status(400).send("You have already sent a friend request to this player, duplicate requests are not permitted.");

    await helpers.NotifyPlayer(target, notificationTemplates.friendRequest, {
        "sendingPlayer": req.user.id,
        "headerText": `Friend Request`,
        "bodyText": `Hey there ${recievingData.public.nickname}! ${sendingData.public.nickname} has sent you a friend request! Press the "Profile" button to see their profile. Press "Accept" to become friends with them, or press "Ignore" to decline the request!`,
        "continueText": `Accept`,
        "cancelText": "Ignore"
    });

    res.status(200).send("Successfully sent friend request to player!");
    sendingData.private.friendRequestsSent.push(target);
    await helpers.PushPlayerData(req.user.id, sendingData);
    
    var send = WebSocketV2_MessageTemplate;
    send.code = "standard_notification_recieved";
    send.data = {};
    require('./ws/WebSocketServerV2').ws_connected_clients[target]?.socket?.send(JSON.stringify(send, null, 5));
});

router.post("/accept-request", middleware.authenticateToken, async (req, res) => {
    var {target} = req.body;
    if(typeof target != 'string') return res.status(400).send("No target specified.");

    var recievingData = await helpers.PullPlayerData(req.user.id);
    var sendingData = await helpers.PullPlayerData(target);

    var filteredNotifications = recievingData.notifications.filter(item => item.template === notificationTemplates.friendRequest && item.parameters.sendingPlayer === target);

    for (let index = 0; index < filteredNotifications.length; index++) {
        let itemIndex = recievingData.notifications.findIndex(item => item.template === notificationTemplates.friendRequest && item.parameters.sendingPlayer === target);
        recievingData.notifications.splice(itemIndex);
    }
     
    if(filteredNotifications.length > 0) await helpers.PushPlayerData(req.user.id, recievingData);

    if(await helpers.ArePlayersAnyFriendType(req.user.id, target)) return res.status(400).send("You are already friends with this player.");

    if(!sendingData.private.friendRequestsSent.includes(req.user.id)) return res.status(400).send("This player has not sent you a friend request. API magic won't help you here buddy.");

    await helpers.AddAcquaintance(req.user.id, target, true);

    res.status(200).send("Successfully added acquaintance.");

    // eslint-disable-next-line no-redeclare
    var sendingData = await helpers.PullPlayerData(target);
     
    var index = sendingData.private.friendRequestsSent.findIndex(item => item === req.user.id);
    if(index >= 0) sendingData.private.friendRequestsSent.splice(index);
    await helpers.PushPlayerData(target, sendingData);
});

router.get("/sent-requests", middleware.authenticateToken, async (req, res) => {
    var data = await helpers.PullPlayerData(req.user.id);
    res.status(200).json(data.private.friendRequestsSent);  
});

router.post("/make-acquaintance", middleware.authenticateToken, async (req, res) => {
    var {target} = req.body;
    if(!target) return res.status(400).send("You did not specify a target!");
    var sender = req.user.id;

    if(!await helpers.ArePlayersAnyFriendType(sender, target)) return res.status(400).send("You are not acquaintances, friends, or favorite friends with this user.");

    await helpers.RemoveFriend(sender, target, false);
    await helpers.RemoveFavoriteFriend(sender, target, false);

    await helpers.AddAcquaintance(sender, target, false);
    res.sendStatus(200);
});

router.post("/make-friend", middleware.authenticateToken, async (req, res) => {
    var {target} = req.body;
    if(!target) return res.status(400).send("You did not specify a target!");
    var sender = req.user.id;

    if(!await helpers.ArePlayersAnyFriendType(sender, target)) return res.status(400).send("You are not acquaintances, friends, or favorite friends with this user.");

    await helpers.RemoveAcquaintance(sender, target, false);
    await helpers.RemoveFavoriteFriend(sender, target, false);

    await helpers.AddFriend(sender, target, false);
    res.sendStatus(200);
});

router.post("/make-favorite-friend", middleware.authenticateToken, async (req, res) => {
    var {target} = req.body;
    if(!target) return res.status(400).send("You did not specify a target!");
    var sender = req.user.id;

    if(!await helpers.ArePlayersAnyFriendType(sender, target)) return res.status(400).send("You are not acquaintances, friends, or favorite friends with this user.");

    await helpers.RemoveAcquaintance(sender, target, false);
    await helpers.RemoveFriend(sender, target, false);

    await helpers.AddFavoriteFriend(sender, target, false);
    res.sendStatus(200);
});

router.post("/remove-friend", middleware.authenticateToken, async (req, res) => {
    var {target} = req.body;
    if(!target) return res.status(400).send("You did not specify a target!");
    var sender = req.user.id;

    if(!await helpers.ArePlayersAnyFriendType(sender, target)) return res.status(400).send("You are not acquaintances, friends, or favorite friends with this user.");

    await helpers.RemoveAcquaintance(sender, target, true);
    await helpers.RemoveFriend(sender, target, true);
    await helpers.RemoveFavoriteFriend(sender, target, true);
    res.sendStatus(200);
});

router.post("/decline-request", middleware.authenticateToken, async (req, res) => {
    var {target} = req.body;
    if(!target) return res.status(400).send("You did not specify a target!");
    const sender = req.user.id;

    if(await helpers.ArePlayersAnyFriendType(sender, target)) return res.status(400).send("You are already acquaintances, friends, or favorite friends with this player!");

    var sendingData = await helpers.PullPlayerData(target);
    if(sendingData === null) return res.status(404).send("That user does not exist!");

    var recievingData = await helpers.PullPlayerData(sender);
     
    if(!sendingData.private.friendRequestsSent.includes(sender)) return res.status(400).send("You do not have a pending friend request from this player!");

    while(sendingData.private.friendRequestsSent.includes(sender)) {
        const index = sendingData.private.friendRequestsSent.findIndex(item => item === sender);
        sendingData.private.friendRequestsSent.splice(index);
    }
    await helpers.PushPlayerData(target, sendingData);

    var temp = recievingData.notifications.filter(item => item.template === notificationTemplates.friendRequest && item.parameters.sendingPlayer === target);
    for (let index = 0; index < temp.length; index++) {
        let itemIndex = recievingData.notifications.findIndex(item => item.template === notificationTemplates.friendRequest && item.parameters.sendingPlayer === target);
        if(itemIndex >= 0) recievingData.notifications.splice(itemIndex);
        else break;
    }

    await helpers.PushPlayerData(sender, recievingData);
    res.status(200).send("Declined friend request.");
});

router.get("/acquaintances", middleware.authenticateToken, async (req, res) => {
    const data = await helpers.PullPlayerData(req.user.id);
    var dictionary = {};
    for (let index = 0; index < data.private.acquaintances.length; index++) {
        const element = data.private.acquaintances[index];
        let player = await helpers.PullPlayerData(element);
        dictionary[element] = player.public;
    }
    return res.status(200).json(dictionary);
});

router.get("/friends", middleware.authenticateToken, async (req, res) => {
    const data = await helpers.PullPlayerData(req.user.id);
    var dictionary = {};
    for (let index = 0; index < data.private.friends.length; index++) {
        const element = data.private.friends[index];
        let player = await helpers.PullPlayerData(element);
        dictionary[element] = player.public;
    }
    return res.status(200).json(dictionary);
});

router.get("/favorite-friends", middleware.authenticateToken, async (req, res) => {
    const data = await helpers.PullPlayerData(req.user.id);
    var dictionary = {};
    for (let index = 0; index < data.private.favoriteFriends.length; index++) {
        const element = data.private.favoriteFriends[index];
        let player = await helpers.PullPlayerData(element);
        dictionary[element] = player.public;
    }
    return res.status(200).json(dictionary);
});

router.get("/all-friend-types", middleware.authenticateToken, async (req, res) => {
    const data = await helpers.PullPlayerData(req.user.id);

    const array1 = helpers.MergeArraysWithoutDuplication(data.private.acquaintances, data.private.friends);
    const all = helpers.MergeArraysWithoutDuplication(array1, data.private.favoriteFriends);

    var dictionary = {};
    for (let index = 0; index < all.length; index++) {
        const element = all[index];
        let player = await helpers.PullPlayerData(element);

        if (player == null) continue;
        dictionary[element] = player.public;
    }
    return res.status(200).json(dictionary);
});

module.exports = router;