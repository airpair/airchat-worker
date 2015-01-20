var dotenv = require("dotenv");
dotenv.load();

var Firebase = require('firebase'),
    CoreChatServer = require('./coreChatServer'),
    ref = new Firebase(process.env.FIREBASE_URL),
    ccs = new CoreChatServer(ref);