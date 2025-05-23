require('dotenv').config();
const fs = require('fs');
const config = require('./config.json');

const notificationTemplates = {
    invite: "invite",
    friendRequest: "friendRequest",
    messageRecieved: "messageRecieved"
};

module.exports = {
    PullPlayerData: PullPlayerData,
    PushPlayerData: PushPlayerData,
    NotifyPlayer: NotifyPlayer,
    ArePlayersAnyFriendType: ArePlayersAnyFriendType,
    ArePlayersAcquantances: ArePlayersAcquantances,
    ArePlayersFriends: ArePlayersFriends,
    ArePlayersFavoriteFriends: ArePlayersFavoriteFriends,
    RemoveAcquaintance: RemoveAcquaintance,
    RemoveFriend: RemoveFriend,
    RemoveFavoriteFriend: RemoveFavoriteFriend,
    AddFriend: AddFriend,
    AddFavoriteFriend: AddFavoriteFriend,
    AddAcquaintance: AddAcquaintance,
    getUserID: getUserID,
    getAccountCount: getAccountCount,
    auditLog: auditLog,
    MergeArraysWithoutDuplication: MergeArraysWithoutDuplication,
    BanPlayer: BanPlayer,
    onPlayerReportedCallback: onPlayerReportedCallback,
    check: check
};

/**
 * Pulls the full account data of a player.
 * @param {String} id The account ID of the player whose data should be retrieved.
 * @returns {Object} The player's account data.
 */
async function PullPlayerData(id) {
    const db = require('./index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
    const account = await db.collection('accounts').findOne({_id: {$eq: id, $exists: true}});
    return account;
}

/**
 * Completely overwrites a player's account file/document.
 * @param {String} id The ID of the player whose data should be updated.
 * @param {Object} data The full data of the specified player's account
 */
async function PushPlayerData(id, data) {
    const db = require('./index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
    await db.collection('accounts').replaceOne({_id: {$eq: id, $exists: true}}, data, {upsert: true});
}

/**
 * Sends a notification to a player. This does not send them a WebSocket message.
 * @param {String} id The ID of the player to notify.
 * @param {String} template The template to use for the notification.
 * @param {Object} params The parameters of this notification. (Template specific.)
 * @returns 
 */
async function NotifyPlayer(id, template, params) {
    if(!(Object.values(notificationTemplates).includes(template))) return false;
    var data = await PullPlayerData(id);
    if(data === null) return false;

    const notification = {
        template: template,
        parameters: params
    };
    data.notifications.push(notification);

    await PushPlayerData(id, data);
    return true;
}

/**
 * Checks whether the specified players have the other in their acquaintance, friend, or favorite friend lists.
 * @param {String} player1 The ID of the first player.
 * @param {String} player2 The ID of the second player.
 * @returns {Boolean} Whether or not the players are any type of friend.
 */
async function ArePlayersAnyFriendType(player1, player2) {
    var data = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);
    return data.private.acquaintances.includes(player2) || 
          data.private.friends.includes(player2) || 
          data.private.favoriteFriends.includes(player2) ||
          data2.private.acquaintances.includes(player1) || 
          data2.private.friends.includes(player1) ||
          data2.private.favoriteFriends.includes(player1);
}

/**
 * Checks whether one of the players has the other in their acquaintances list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @returns {Boolean} Whether or not the players are acquaintances.
 */
async function ArePlayersAcquantances(player1, player2) {
    var data = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);
    return data.private.acquaintances.includes(player2) ||
          data2.private.acquaintances.includes(player1);
}

/**
 * Checks whether one of the players has the other in their friends list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @returns {Boolean} Whether or not the players are friends.
 */
async function ArePlayersFriends(player1, player2) {
    var data = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);
    return data.private.friends.includes(player2) ||
          data2.private.friends.includes(player1);
}

/**
 * Checks whether one of the players has the other in their favorite friends list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @returns {Boolean} Whether or not the players are favorite friends.
 */
async function ArePlayersFavoriteFriends(player1, player2) {
    var data = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);
    return data.private.favoriteFriends.includes(player2) ||
          data2.private.favoriteFriends.includes(player1);
}

/**
 * Removes a player from another player's acquaintance list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @param {Boolean} both Whether or not to remove the acquaintance from both players.
 */
async function RemoveAcquaintance(player1, player2, both) {
    var data1 = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);

    var index1 = data1.private.acquaintances.findIndex(item => item === player2);
    if(index1 >= 0) data1.private.acquaintances.splice(index1);

    var index2 = data2.private.acquaintances.findIndex(item => item === player1);
    if(index2 >= 0 && both) data2.private.acquaintances.splice(index2);

    await PushPlayerData(player1, data1);
    await PushPlayerData(player2, data2);
}

/**
 * Removes a player from another player's friends list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @param {Boolean} both Whether or not to remove the friend from both players.
 */
async function RemoveFriend(player1, player2, both) {
    var data1 = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);

    var index1 = data1.private.friends.findIndex(item => item === player2);
    if(index1 >= 0) data1.private.friends.splice(index1);

    var index2 = data2.private.friends.findIndex(item => item === player1);
    if(index2 >= 0 && both) data2.private.friends.splice(index2);

    await PushPlayerData(player1, data1);
    await PushPlayerData(player2, data2);
}

/**
 * Removes a player from another player's favorite friends list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @param {Boolean} both Whether or not to remove the favorite friend from both players.
 */
async function RemoveFavoriteFriend(player1, player2, both) {
    var data1 = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);

    var index1 = data1.private.favoriteFriends.findIndex(item => item === player2);
    if(index1 >= 0) data1.private.favoriteFriends.splice(index1);

    var index2 = data2.private.favoriteFriends.findIndex(item => item === player1);
    if(index2 >= 0 && both) data2.private.favoriteFriends.splice(index2);

    await PushPlayerData(player1, data1);
    await PushPlayerData(player2, data2);
}

/**
 * Adds a player to another player's acquaintances list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @param {Boolean} both Whether or not the addition is mutual.
 */
async function AddAcquaintance(player1, player2, both) {
    var data1 = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);

    if(!data1.private.acquaintances.includes(player2)) 
    {
        data1.private.acquaintances.push(player2);
        await PushPlayerData(player1, data1);
    }
    if(!data2.private.acquaintances.includes(player1) && both) {
        data2.private.acquaintances.push(player1);
        await PushPlayerData(player2, data2);
    }
}

/**
 * Adds a player to another player's friends list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @param {Boolean} both Whether or not the addition is mutual.
 */
async function AddFriend(player1, player2, both) {
    var data1 = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);

    if(!data1.private.friends.includes(player2)) 
    {
        data1.private.friends.push(player2);
        await PushPlayerData(player1, data1);
    }
    if(!data2.private.friends.includes(player1) && both) {
        data2.private.friends.push(player1);
        await PushPlayerData(player2, data2);
    }
}

/**
 * Adds a player to another player's favorite friends list.
 * @param {String} player1 The ID of player A.
 * @param {String} player2 The ID of player B.
 * @param {Boolean} both Whether or not the addition is mutual.
 */
async function AddFavoriteFriend(player1, player2, both) {
    var data1 = await PullPlayerData(player1);
    var data2 = await PullPlayerData(player2);

    if(!data1.private.favoriteFriends.includes(player2)) 
    {
        data1.private.favoriteFriends.push(player2);
        await PushPlayerData(player1, data1);
    }
    if(!data2.private.favoriteFriends.includes(player1) && both) {
        data2.private.favoriteFriends.push(player1);
        await PushPlayerData(player2, data2);
    }
}

/**
 * Retrieves the account ID associated with the given username.
 * @param {String} username The username of the account to fetch.
 * @returns {String|null} The ID of the account associated with that username.
 */
async function getUserID(username) {
    const db = require('./index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
    const all = await db.collection('accounts').find({}).toArray();
    username = username.toLowerCase();
    for(const item of all) {
        if(item.public.username.toLowerCase() === username.toLowerCase()) return item._id;
    }
    return null;
}

/**
 * Fetches the number of accounts in the database.
 * @returns {Number} The total number of accounts in the database.
 */
async function getAccountCount() {
    const db = require('./index').mongoClient.db(process.env.MONGOOSE_DATABASE_NAME);
    const count = await db.collection('accounts').countDocuments();
    return count - 1;
}

/**
 * Logs an audit event, used for security investigations and verifying user reports.
 * @param {String} message The audit event to log.
 * @param {Boolean} isRaw Whether or not to wrap the text in a code block for Discord webhooks.
 */
function auditLog(message, isRaw) {
    let data = [];
    try {
        data = JSON.parse(fs.readFileSync("./data/audit.json"));
    } catch {
        data = [];
    }

    const ts = Date.now();

    const log = `${ts} - ${message}`;

    data.push(log);
    const final = JSON.stringify(data, null, "   ");
    fs.writeFileSync("./data/audit.json", final);

    console.log(log);

    if (!process.env.AUDIT_SERVER_ID || !process.env.AUDIT_WEBHOOK_URI) return;
    const globalAuditMessage = 
          isRaw ? 
              `API audit log from server.\nID: \`${process.env.AUDIT_SERVER_ID}\`\nMessage:\n${message}` : 
            `API audit log from server.\nID: \`${process.env.AUDIT_SERVER_ID}\`\nMessage:\`${message}\``;
    
    fetch(
        process.env.AUDIT_WEBHOOK_URI,
        {
            'method': 'POST',
            'headers': {
                'Content-Type': 'application/json'
            },
            'body': JSON.stringify({
                'content': globalAuditMessage
            })
        }
    );
}

/**
 * Merges two arrays without duplication.
 * @param {any[]} a 
 * @param {any[]} b 
 * @returns {any[]} The union of both arrays with no duplicates.
 */
function MergeArraysWithoutDuplication(a, b) {
    return a.concat(b.filter((item) => a.indexOf(item) < 0));
}

/**
 * Called when a player is reported, used to perform administrative actions and potentially ban the player.
 * @param {Object} reportData Information about the report event.
 * @param {Number} reportData.timestamp The timestamp of the report.
 * @param {String} reportData.reportingUser The ID of the user who reported the player.
 * @param {String} reportData.reportedUser The ID of the user who was reported.
 * @param {String} reportData.reason The reason for the report.
 */
async function onPlayerReportedCallback(reportData) {
    var reportedData = await PullPlayerData(reportData.reportedUser);
    var reportingData = await PullPlayerData(reportData.reportingUser);

    if(
        reportingData.private.availableTags.includes("Community Support") ||
          reportingData.private.availableTags.includes("Community Support Team") ||
          reportingData.private.availableTags.includes("Developer") ||
          reportingData.private.availableTags.includes("Moderator") ||
          reportingData.private.availableTags.includes("Founder")
    ) {
        await BanPlayer(reportData.reportedUser, reportData.reason, 1, reportData.reportingUser);
        auditLog(`!! MODERATOR ACTION !!   Moderator ${reportingData.nickname} (@${reportingData.username}) reported user ${reportedData.nickname} (@${reportedData.username}) for the reason of ${reportData.reason}, resulting in them being automatically timed out for 1 hour.`);
          
        var index = reportingData.auth.reportedUsers.findIndex(item => item === reportData.reportedUser);
        if(index >= 0) {
            reportingData.auth.reportedUsers.splice(index);
            await PushPlayerData(reportData.reportingUser, reportingData);
        }
    } else if (reportedData.auth.recievedReports.length >= config.timeout_at_report_count) {
        await BanPlayer(reportData.reportedUser, `Automated timeout for recieving ${config.timeout_at_report_count} or more reports. This timeout will not affect your moderation history unless it is found to be 100% justified.`, 6, reportData.reportingUser);
        auditLog(`!! MODERATION ACTION !! User ${reportingData.nickname} (@${reportedData.username}) was timed out for 6 hours for recieving ${config.timeout_at_report_count} reports. Please investigate!`);
    }
}

/**
 * Bans a player from the game for the specified duration.
 * @param {String} id The ID of the player to ban.
 * @param {String} reason The reason for the ban.
 * @param {Number} duration The duration of the ban in hours.
 * @param {Boolean} moderator Did a moderator ban the player?
 * @returns 
 */
async function BanPlayer(id, reason, duration, moderator) {
    let data = await PullPlayerData(id);

    const endTS = Date.now() + (duration * 60); //convert duration from hours to a unix timestamp
     
    const ban = {
        reason: reason,
        endTS: endTS,
        moderator: moderator
    };

    data.auth.bans.push(ban);
    await PushPlayerData(id, data);

    let clients = require('./routers/ws/WebSocketServerV2').ws_connected_clients;
    if(!Object.keys(clients).includes(id)) return;
    clients[id].socket.close();
}

/**
 * Checks a string for potential profanity. This is not a foolproof method, and should not be used as a replacement for human moderation.
 * Susceptible to the [Scunthorpe Problem](https://en.wikipedia.org/wiki/Scunthorpe_problem).
 * @param {String} string The string to check for potential profanity.
 * @returns {Boolean} Whether or not the string contains the potential for profanity.
 */
function check(string) {
    const words = require('./data/badwords/array');
    const tlc = string.toLowerCase();

    for(const word of words) {
        if(tlc.includes(word)) return true;
    }
    return false;
}
