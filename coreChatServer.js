var Firebase = require('firebase'),
    _ = require('lodash');

var CoreChatServer = function (ref) {
    this._ref = ref;
    this.rooms = {};
    this.members = {};
    
    this._ref.authWithCustomToken(process.env.FIREBASE_SECRET, (function (err, auth) {
        if (!err)
            console.log("Successfully authenticated as admin. Running...")
        
        this._outboxRef = ref.child("outbox");
        this._transfersRef = ref.child("transfers");

        ref.child("members/byTag").remove();
            
        // Watch for new outgoing messages
        this._handleMessages();
        this._handleMembers();
        this._handleTransfers();
        this._handleMembersByPage();
        
        ref.child("rooms/byRID").on("child_added", (function (snapshot) {
            var val = snapshot.val();
            val.memberCount = Object.keys(val.members).length;
            this.rooms[snapshot.key()] = val;
        }).bind(this));
        
        ref.child("members/byMID").on("child_added", (function (snapshot) {
            var val = snapshot.val();
            val.id = snapshot.key();
            this.members[snapshot.key()] = val;
        }).bind(this));
        
        ref.child("members/byMID").on("child_removed", (function (snapshot) {
            delete this.members[snapshot.key()];
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
                    
            self.memberPages[memberId] = rawMember.page.url;   
        }
        
        if (rawMember.tags) {
            _.forEach(rawMember.tags, function (t, tag) {
                console.log("adding tag", tag, memberId, t)
                if (t)
                    self._ref
                        .child("members/byTag")
                        .child(tag)
                        .child(memberId)
                        .set(true);
                else
                    self._ref
                        .child("members/byTag")
                        .child(tag)
                        .child(memberId)
                        .remove()
            });
        }
    } else if (rawMember.status == "offline") {
        if (rawMember.page) {
            self._ref
                .child("members/byPage")
                .child(rawMember.page.url)
                .child(memberId)
                .remove();
        }
        
        if (rawMember.tags) {
            _.forEach(rawMember.tags, function (t, tag) {
                console.log("removing tag", tag, memberId)
                self._ref
                    .child("members/byTag")
                    .child(tag)
                    .child(memberId)
                    .remove();
            });
        }
    }
}

CoreChatServer.prototype._handleMembersByPage = function () {
    var self = this;
    self._ref.child("members/byPage").on("child_added", function (pageSnapshot) {
        pageSnapshot.ref().on("child_added", self._processMemberByPage.bind(self, pageSnapshot));
        pageSnapshot.ref().on("child_changed", self._processMemberByPage.bind(self, pageSnapshot));
    }); 
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
                members = {},
                mentionsRe = /@([A-Za-z0-9_-]+)/gi;
            
            // Notify for any @notifications
            while ((member = mentionsRe.exec(rawMessage.body)) !== null)
            {
                var memberName = member[1];
                _.foreach(members, function (inRoom, memberId) {
                     var member = this.members[memberId];
                     if (memberName && memberName == member.name) {
                        mentions[member.id] = true;
                        self.ref.child("members/byMID").child(member.id).child("notifications").push({
                            "type": "mention",
                            "info": {
                                "to": rawMessage.to,
                                "from": rawMessage.from,
                                "body": rawMessage.body
                            }
                        });   
                     }
                });
            }
            
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