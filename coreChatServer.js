var Firebase = require('firebase'),
    _ = require('lodash');

var CoreChatServer = function (ref) {
    this._ref = ref;
    this.rooms = {};
    
    this._ref.authWithCustomToken(process.env.FIREBASE_SECRET, (function (err, auth) {
        if (!err)
            console.log("Successfully authenticated as admin. Running...")
        
        this._outboxRef = ref.child("outbox");
        this._transfersRef = ref.child("transfers");

        ref.child("members/byRole").remove();
        
        // Clean up if we shut down the server
        ref.child("members/byRole").onDisconnect().remove();
        ref.child("members/byPage").onDisconnect().remove();
            
        // Watch for new outgoing messages
        this._handleMessages();
        this._handleMembers();
        this._handleTransfers();
        
        ref.child("rooms/byRID").on("child_added", (function (snapshot) {
            snapshot.ref().on("value", (function (snapshot) {
                if (!snapshot.val()) {
                    snapshot.ref().off("value");
                    return;
                }
                var val = snapshot.val();
                val.memberCount = Object.keys(val.members || {}).length;
                this.rooms[snapshot.key()] = val;  
            }).bind(this));
        }).bind(this));
    }).bind(this));
};

CoreChatServer.prototype._handleMembers = function () {
    var self = this;
    
    self.memberStatuses = {},
    self.memberPages = {};
    
    self._ref.child("members/byMID")
        .on('child_changed', this._processMember.bind(this));

    self._ref.child("members/byMID")
        .on('child_added', this._processMember.bind(this));
        
    setInterval(function () {
        var now = (new Date().getTime());
        self._ref.child('members/byMID').once("value", function (membersSnapshot) {
            membersSnapshot.forEach(function (memberSnapshot) {
                var member = memberSnapshot.val(),
                    id = memberSnapshot.key(),
                    seen = member.ping? member.ping.seen : 0,
                    diff = now-seen,
                    ref = memberSnapshot.ref();
                    
                if (diff > 60e3 && member.status !== "offline") {
                    ref.child("status").set("offline");
                    //console.log("Setting member offline", member)
                } 
            });
        });
    }, 60e3);
    
    setInterval(function () {
        var byPage = {};
        self._ref.child("members/byMID").once("value", function (membersSnapshot) {
            membersSnapshot.forEach(function (memberSnapshot) {
                var member = memberSnapshot.val(),
                    memberId = memberSnapshot.key(),
                    url = member.page? member.page.url.replace(/\./g, '') : false;
                    
                if (member.status == "online" && url) {
                    var page = byPage[url] || {};
                    page[memberId] = true;
                    byPage[url] = page;
                }
            });
            self._ref.child("members/byPage").set(byPage);
            console.log('byPage', byPage)
        });
    }, 30e3);
};

CoreChatServer.prototype._processMember = function (memberSnapshot) {
    var self = this;
    // Deal with online status
    var rawMember = memberSnapshot.val(),
        memberId = memberSnapshot.key(),
        memberRef = memberSnapshot.ref(),
        lastStatus = self.memberStatuses[memberId];
        
    self._ref
        .child("members/byStatus")
        .child(rawMember.status || 'offline')
        .child(memberId)
        .set(true);
        
    if (lastStatus && lastStatus !== rawMember.status)
        self._ref
            .child("members/byStatus")
            .child(lastStatus)
            .child(memberId)
            .remove();
            
    self.memberStatuses[memberId] = rawMember.status;
    
    // Deal with current page
    if (rawMember.status !== "offline") {
        var lastPage = self.memberPages[memberId];
        
        _.forEach(rawMember.roles, function (t, role) {
            var roleRef = self._ref
                .child("members/byRole")
                .child(role)
                .child(memberId);
                
            if (!t) {
                roleRef.remove();
                memberRef
                    .child("roles")
                    .child(role)
                    .remove();
            } else {
                roleRef.set(true);
            }
        });
        
        _.forEach(rawMember.rooms, function (t, room) {
            var roomRef = self._ref
                .child("rooms/byRID")
				.child(room);
				
			roomRef.once("value", function (roomSnapshot) {
			    var rawRoom = roomSnapshot.val() || {},
			        alreadyInRoom = rawRoom.members && rawRoom.members[memberId];
			    
			    if (!alreadyInRoom && !rawRoom.closed) {
			       roomRef.child("members")
                    .child(memberId)
                    .set(t); 
			    } else if (rawRoom.closed) {
			        memberRef.child("rooms").child(room).remove();
			    }
			})
        });
    
        if (rawMember.roles) {
            _.forEach(rawMember.roles, function (t, role) {
                if (t)
                    self._ref
                        .child("members/byRole")
                        .child(role)
                        .child(memberId)
                        .set(true);
                else
                    self._ref
                        .child("members/byRole")
                        .child(role)
                        .child(memberId)
                        .remove()
            });
        }
    } else if (rawMember.status == "offline") {
        if (rawMember.roles) {
            _.forEach(rawMember.roles, function (t, role) {
                self._ref
                    .child("members/byRole")
                    .child(role)
                    .child(memberId)
                    .remove();
            });
        }
    }
}

CoreChatServer.prototype._processMemberByPage = function (pageSnapshot, memberSnapshot) {
    this._ref.child("members/byMID").child(memberSnapshot.key()).child("page/url").once("value", function (urlSnapshot) {
        var url = urlSnapshot.val();
        if (url !== pageSnapshot.key()) {
            memberSnapshot.ref().remove();
        }
    });
}

CoreChatServer.prototype._handleMessages = function () {
    var self = this;
    self._outboxRef.on("child_added", function (messageSnapshot) { 
        var rawMessage = messageSnapshot.val(),
            messageRef = messageSnapshot.ref(),
            roomsRef = self._ref.child("rooms/byRID"),
            membersToJoin = {},
            roomRef, roomId, member, historyMessageRef;
        
        if (rawMessage.type == "member" || (rawMessage.to.split("^^v^^").length > 1 && (!self.rooms[rawMessage.to] || self.rooms[rawMessage.to].memberCount < 2))) {
            console.log("room tooing")
            var members = rawMessage.to.split("^^v^^"),
                toSet = false;
            
            members.forEach(function (memberId, index) {
                membersToJoin[memberId] = true;
               if (memberId !== rawMessage.from) {
                   rawMessage.to = memberId;
                   toSet = true;
               } 
            });
            
            if (!toSet) rawMessage.to = rawMessage.from;

            roomId = [rawMessage.from, rawMessage.to].sort().join('^^v^^');
            rawMessage.type = "member";
        } else if (rawMessage.type == "room") {
            roomId = rawMessage.to;
        }
        
        console.log(rawMessage)
            
        roomRef = roomsRef.child(roomId);
        rawMessage.timestamp = Firebase.ServerValue.TIMESTAMP;
        historyMessageRef = roomRef.child("history").push(rawMessage);
        console.log(rawMessage)
        messageRef.remove();
        
        membersToJoin[rawMessage.from] = true;
        
        if (rawMessage.type == 'member')
            membersToJoin[rawMessage.to] = true;
            
        for (var memberId in membersToJoin) {
            roomRef
                .child("members")
                .child(memberId)
                .set(true);
            
            self._ref
                .child('members/byMID')
                .child(memberId)
                .child('rooms')
                .child(roomId)
                .set(true);
        }
        
        historyMessageRef.once("value", function (historyMessageSnapshot) {
            var timestamp = historyMessageSnapshot.val().timestamp;
            
            self._ref
                .child("rooms/byLastMessage")
                .child(roomId)
                .setWithPriority(true, timestamp);
        });
        
        // Load all members of this room
        roomRef.child("members").once("value", function (membersSnapshot) {
            var mentions = {},
                members = membersSnapshot.val(),
                mentionsRe = /@([A-Za-z0-9_-]+)/gi;
            
            // Notify for any @notifications
            /*process.nextTick(function () {
                while ((member = mentionsRe.exec(rawMessage.body)) !== null)
                {
                    var memberInitials = member[1];
        
                    self._ref
                        .child("members/byMID")
                        .orderByChild("initials")
                        .equalTo(memberInitials.toUpperCase())
                        .once("value", function (initialMatchesSnapshot) {
                            initialMatchesSnapshot.forEach(function (initialMatchSnapshot) {
                                var id = initialMatchSnapshot.key();
                                if (members[id]) {
                                    console.log('@mentioned', id);
                                    self._ref.child("members/byMID").child(id).child("notifications").push({
                                        "type": "mention",
                                        "info": {
                                            "to": rawMessage.to,
                                            "from": rawMessage.from,
                                            "body": rawMessage.body
                                        }
                                    });       
                                }
                            });
                        })
                } 
            });*/
            
            // Notify for any normal notifications
            membersSnapshot.forEach(function (userSnapshot) {
                var rawUser = userSnapshot.key();
                // For each member who didn't send the message and weren't mentioned, 
                // send a notification
                if (rawUser == rawMessage.from || mentions[rawUser]) return; 
                
                self._ref.child("members/byMID").child(rawUser).child("notifications").push({
                    "type": "message",
                    "info": {
                        "to": roomId,
                        "from": rawMessage.from,
                        "body": rawMessage.body
                    }
                });
            });
        });
    });
};

CoreChatServer.prototype._handleTransfers = function () {
    var self = this;
    
    self._transfersRef.on("child_added", function (transferSnapshot) { 
        var rawTransfer = transferSnapshot.val(),
            toUser, fromUser, next;
        
        next = function () {
            if (!toUser || !fromUser) return; 
            
            var toUserRaw = toUser.val(),
                fromUserRaw = fromUser.val();
                
            console.log("Performing a transfer from", fromUser.key(), "to", toUser.key());
                
            if (!fromUserRaw || !fromUserRaw.rooms) {
                fromUser.ref().remove();
                transferSnapshot.ref().remove();
                return;    
            }
            
            _.forEach(fromUserRaw.rooms, function (_, room) {
                var roomRef = self._ref.child("rooms/byRID").child(room),
                    membersRef = roomRef.child("members");
                    
                membersRef.child(fromUser.key()).remove();
                membersRef.child(toUser.key()).set(true);
                
                roomRef.child("history").on("child_added", function (messageSnapshot) {
                    var rawMessage = messageSnapshot.val();
                    
                    if (rawMessage.from == fromUser.key()) {
                        messageSnapshot.ref().child("from").set(toUser.key());
                    }
                });
            });
            
            toUser.ref().child("rooms").update(fromUserRaw.rooms);
            fromUser.ref().remove();
            transferSnapshot.ref().remove();
        };
        
        self._ref.child("members/byMID").child(rawTransfer.to).once("value", function (snap) {
           toUser = snap;
           next();
        });
        
        self._ref.child("members/byMID").child(rawTransfer.from).once("value", function (snap) {
           fromUser = snap;
           next();
        });
    });
};

module.exports = CoreChatServer;