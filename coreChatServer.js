var Firebase = require('firebase'),
    _ = require('lodash');

var CoreChatServer = function (ref) {
    this._ref = ref;
    this.rooms = {};
    
    this._ref.authWithCustomToken("BKE9PP6DP4k06Es10nD6Rvh9443Fz7XBstb6fg54", (function (err, auth) {
        console.log(arguments);
        
        this._outboxRef = ref.child("outbox");
        this._transfersRef = ref.child("transfers");
            
        // Watch for new outgoing messages
        this._handleMessages();
        this._handleMembers();
        this._handleTransfers();
        
        ref.child("rooms/byRID").on("child_added", (function (snapshot) {
            var val = snapshot.val();
            val.memberCount = Object.keys(val.members).length;
            this.rooms[snapshot.name()] = val;
        }).bind(this));
    }).bind(this));
};

CoreChatServer.prototype._handleMembers = function () {
    var self = this,
        memberStatuses = {},
        memberPages = {};
    
    self._ref.child("members/byMID")
        .on('child_changed', function (memberSnapshot) {
            // Deal with online status
            var rawMember = memberSnapshot.val(),
                memberId = memberSnapshot.name(),
                memberRef = memberSnapshot.ref(),
                lastStatus = memberStatuses[memberId];
                
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
                    
            memberStatuses[memberId] = rawMember.status;
            
            // Deal with current page
            
            if (rawMember.status !== "offline") {
                var lastPage = memberPages[memberId];
                
                _.forEach(rawMember.tags, function (t, tag) {
                    var tagRef = self._ref
                        .child("members/byTag")
                        .child(tag)
                        .child(memberId);
                        
                    if (!t) {
                        tagRef.remove();
                        memberRef
                            .child("tags")
                            .child(tag)
                            .remove();
                    } else {
                        tagRef.set(true);
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
                
                if (rawMember.page) {
                    self._ref
                        .child("members/byPage")
                        .child(rawMember.page.url || "Unknown")
                        .child(memberId)
                        .setWithPriority(true, rawMember.page.timestamp);
                        
                    if (lastPage && lastPage !== rawMember.page.url)
                        self._ref
                            .child("members/byPage")
                            .child(lastPage)
                            .child(memberId)
                            .remove();
                            
                    memberPages[memberId] = rawMember.page.url;   
                }
            } else if (rawMember.page) {
                _.forEach(rawMember.tags, function (t, tag) {
                    self._ref
                        .child("members/byTag")
                        .child(tag)
                        .child(memberId)
                        .remove();
                });
                
                self._ref
                    .child("members/byPage")
                    .child(rawMember.page.url)
                    .child(memberId)
                    .remove();
            }
        });
};

CoreChatServer.prototype._handleMessages = function () {
    var self = this;
    self._outboxRef.on("child_added", function (messageSnapshot) { 
        var rawMessage = messageSnapshot.val(),
            messageRef = messageSnapshot.ref(),
            roomsRef = self._ref.child("rooms/byRID"),
            membersToJoin = {},
            roomRef, roomId, member, historyMessageRef;
            
        console.log(rawMessage)
        
        if (rawMessage.type == "member" || (rawMessage.to.split("^^v^^").length > 1 && (!self.rooms[rawMessage.to] || !self.rooms[rawMessage.to].memberCount > 1))) {
            var members = rawMessage.to.split("^^v^^"),
                toSet = false;
            
            members.forEach(function (memberId, index) {
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
                mentionsRe = /@([A-Za-z0-9_-]+)/gi;
            
            // Notify for any @notifications
            while ((member = mentionsRe.exec(rawMessage.body)) !== null)
            {
                member = member[1];
                mentions[member] = true;
                self.ref.child("members/byMID").child(member).child("notifications").push({
                    "type": "mention",
                    "info": {
                        "to": rawMessage.to,
                        "from": rawMessage.from,
                        "body": rawMessage.body
                    }
                });
            }
            
            // Notify for any normal notifications
            membersSnapshot.forEach(function (userSnapshot) {
                var rawUser = userSnapshot.name();
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
                
            console.log("Performing a transfer from", fromUser.name(), "to", toUser.name());
                
            if (!fromUserRaw || !fromUserRaw.rooms) {
                fromUser.ref().remove();
                transferSnapshot.ref().remove();
                return;    
            }
            
            _.forEach(fromUserRaw.rooms, function (_, room) {
                var roomRef = self._ref.child("rooms/byRID").child(room),
                    membersRef = roomRef.child("members");
                    
                membersRef.child(fromUser.name()).remove();
                membersRef.child(toUser.name()).set(true);
                
                roomRef.child("history").on("child_added", function (messageSnapshot) {
                    var rawMessage = messageSnapshot.val();
                    
                    if (rawMessage.from == fromUser.name()) {
                        messageSnapshot.ref().child("from").set(toUser.name());
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