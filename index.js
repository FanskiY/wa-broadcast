const Config = require('./config.json')
const Kurir = require('./kurir')
const fs = require('fs')
const qrcode = require('qrcode-terminal')
const Downloader = require('./downloader')
const WebSocket = require('ws')
const _ = require('lodash')
const {
    Client,
    MessageMedia,
    LocalAuth
} = require('whatsapp-web.js');
const downloadManager = new Downloader()
let kurir
let filePath


const redis = require("redis");
let redisNotReady = true;
let redisClient = redis.createClient({
    url: 'redis://redis:6379',
    // host: '127.0.0.1',
    port: 6379
});
redisClient.on("error", (err) => {
    console.log("error", err)
});
redisClient.on("connect", (err) => {
    console.log("connect");
});
redisClient.on("disconnect", (err) => {
    console.log("disconnect");
});
redisClient.on("ready", (err) => {
    redisNotReady = false;
    console.log("ready");
});
redisClient.connect();

const start = async function () {
    let currentId = '0-0';
    while (true) {
        try {
            let response = await redisClient.xRead(
                {
                    key: process.env.QUEUE + '_message',
                    id: currentId
                }, {
                    // Read 1 entry at a time, block for 5 seconds if there are none.
                    COUNT: 1,
                    BLOCK: 3000
                }
            );

            if (response) {
                // console.log(JSON.stringify(response));
                console.log(response[0].messages[0].message.value);

                handleMessage(response[0].messages[0].message.value);
                // Get the ID of the first (only) entry returned.
                currentId = response[0].messages[0].id;
                redisClient.xDel(process.env.QUEUE + '_message', currentId)
            } else {
                // Response is null, we have read everything that is
                // in the stream right now...
                console.log('No new stream entries.');
            }
        } catch (err) {
            console.error(err);
        }
    }
}

const client = new Client({
    authStrategy: process.env.WADIR ? new LocalAuth({dataPath: ".wwebjs_auth/" + process.env.WADIR}) : new LocalAuth(),
    puppeteer: Config.puppeteer
});
// You can use an existing session and avoid scanning a QR code by adding a "session" object to the client options.
// This object must include WABrowserId, WASecretBundle, WAToken1 and WAToken2.

client.initialize();

const wss = new WebSocket.Server({
    port: Config.websocketPort
})

client.on('qr', (qr) => {
    // NOTE: This event will not be fired if a session is specified.
    console.log('QR RECEIVED', qr);
    if (redisClient.isOpen) {
        redisClient.xAdd(process.env.QUEUE, '*', {'type': 'qr', 'value': qr});
        redisClient.expire(process.env.QUEUE, 10)
    }
    var obj = new Object();
    obj.type = "qr";
    obj.qr = qr;
    wss.clients.forEach(function each(cli) {
        if (cli.readyState === WebSocket.OPEN) {
            cli.send(JSON.stringify(obj));
        }
    });
    if (Config.puppeteer.headless) {
        qrcode.generate(qr, {small: true});
    }
});

client.on('authenticated', (session) => {
    console.log('AUTHENTICATED', session);
    // sessionCfg = session;
    // fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), function (err) {
    //     if (err) {
    //         console.error(err);
    //     }
    // });
});

client.on('auth_failure', msg => {
    // Fired if session restore was unsuccessfull
    if (redisClient.isOpen) {
        redisClient.xAdd(process.env.QUEUE, '*', {'type': 'auth', 'status': 'disconnected'});
        redisClient.expire(process.env.QUEUE, 600)
    }
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('ready', () => {
    console.log('READY');
    kurir = new Kurir(client)
    start();
    if (redisClient.isOpen) {
        redisClient.xAdd(process.env.QUEUE, '*', {'type': 'auth', 'status': 'ready'});
        redisClient.expire(process.env.QUEUE, 600)
    }
});

client.on('message', async msg => {
    console.log(msg);
    // if(kurir === undefined) return
    // if (msg.body.startsWith('/')) {
    //     // Send a new message to the same chat
    //     kurir.chat(msg);
    // }
    wss.clients.forEach(function each(cli) {
        if (cli.readyState === WebSocket.OPEN) {
            cli.send(JSON.stringify(msg));
        }
    });
});

client.on('message_create', (msg) => {
    // Fired on all message creations, including your own
    if (msg.fromMe) {
        // do stuff here
    }
});

client.on('message_revoke_everyone', async (after, before) => {
    // Fired whenever a message is deleted by anyone (including you)
    console.log(after); // message after it was deleted.
    if (before) {
        console.log(before); // message before it was deleted.
    }
});

client.on('message_revoke_me', async (msg) => {
    // Fired whenever a message is only deleted in your own view.
    console.log(msg.body); // message before it was deleted.
});

client.on('message_ack', (msg, ack) => {
    /*
        == ACK VALUES ==
        ACK_ERROR: -1
        ACK_PENDING: 0
        ACK_SERVER: 1
        ACK_DEVICE: 2
        ACK_READ: 3
        ACK_PLAYED: 4
    */

    if (ack == 3) {
        // The message was read
    }
});

client.on('group_join', (notification) => {
    // User has joined or been added to the group.
    console.log('join', notification);
});

client.on('group_leave', (notification) => {
    // User has left or been kicked from the group.
    console.log('leave', notification);
});

client.on('group_update', (notification) => {
    // Group picture, subject or description has been updated.
    console.log('update', notification);
});

client.on('change_battery', (batteryInfo) => {
    // Battery percentage for attached device has changed
    const {
        battery,
        plugged
    } = batteryInfo;
    console.log(`Battery: ${battery}% - Charging? ${plugged}`);
});

client.on('disconnected', (reason) => {
    if (redisClient.isOpen) {
        redisClient.xAdd(process.env.QUEUE, '*', {'type': 'auth', 'status': 'disconnected'});
        redisClient.expire(process.env.QUEUE, 600)
    }
    console.log('Client was logged out', reason);
});

wss.on('connection', ws => {
    ws.on('message', async message => {
        //console.log(`Received message => ${message}`)
        handleMessage(message);
    })
})

async function handleMessage(e) {
    let i;
    let obj = JSON.parse(e);
    if (obj.type == 'sendWa') {
        //  let validType = ['text', 'image', 'document', 'location', 'video']
        let numbers = obj.data
        let options = {}
        let tmpAttachment = {}
        for (i in numbers) {
            options = numbers[i].options !== undefined ? numbers[i].options : {}
            if (options.media) {
                options.media = new MessageMedia(options.media.mimetype, options.media.b64data, options.media.filename)
            }

            if (numbers[i].url_public) {
                filePath = Config.folderDownload + "/" + numbers[i].url_public.substring(numbers[i].url_public.lastIndexOf('/') + 1);
                await downloadManager.download(numbers[i].url_public, filePath)
                    .then(fileInfo => numbers[i].attachment = fileInfo.path)
                    .catch(err => console.log(err))
            }

            if (numbers[i].attachment !== undefined) {
                if (numbers[i].attachment) {
                    if (fs.existsSync(numbers[i].attachment)) {
                        if (tmpAttachment[numbers[i].attachment] == undefined) {
                            tmpAttachment[numbers[i].attachment] = MessageMedia.fromFilePath(numbers[i].attachment)
                        }
                        options['media'] = tmpAttachment[numbers[i].attachment]
                    }
                }
            }
            // jika mimetype tidak ada dalam list mimetypecaption maka kirim dulu captionnya scecara terpisah
            if (options.media) {
                if (!_.includes(Config.mimetypeCaption, options.media.mimetype)) {
                    if (!_.isEmpty(numbers[i].message)) {
                        client.sendMessage(numbers[i].to, numbers[i].message)
                    }
                }
            }

            client.sendMessage(numbers[i].to, numbers[i].message, options)
        }
        tmpAttachment = {}
    } else if (obj.type === 'checkWa') {
        let numbers = obj.data
        client.isRegisteredUser(numbers[0].to).then(rs => {
                wss.clients.forEach(function each(cli) {
                    if (cli.readyState === WebSocket.OPEN) {
                        let result = {}
                        result["result"] = rs
                        result["phone"] = numbers[0].to
                        result["type"] = "checkWa"
                        cli.send(JSON.stringify(result));
                    }
                });
            }
        );
    }
}
