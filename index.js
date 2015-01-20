var Firebase = require('firebase'),
    CoreChatServer = require('./coreChatServer'),
    ref = new Firebase('https://airpair-chat-dev.firebaseio.com/'),
    ccs = new CoreChatServer(ref);
