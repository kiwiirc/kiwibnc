self.addEventListener('push', async (event) => {
    if (!(self.Notification && self.Notification.permission === 'granted')) {
        return;
    }

    const reg = event.target.registration;

    let data = {};
    if (event.data) {
        data = event.data.json();
    }

    if (data.unregister) {
        // This allows removing a worker via a push notification
        reg.unregister();
        return
    }

    if (!data.notification) {
        return;
    }

    const title = data.notification.title;
    delete data.notification.title;

    let notify;
    try {
        notify = new Notification(title, data.notification);

        if (notify && data.ttl) {
            setTimeout(notify.close.bind(notify), data.notification.ttl);
        }
    } catch (e) {
        if (e.name !== 'TypeError') {
            return;
        }

        // Chrome & Firefox does not support `new Notification` inside of service workers
        const notifyId = generateId();
        data.notification.tag = notifyId;
        notify = reg.showNotification(title, data.notification);

        if (data.notification.ttl) {
            setTimeout(() => {
                reg.getNotifications({ tag: notifyId }).then((notifications) => {
                    notifications.forEach((n) => n.close());
                });
            }, data.notification.ttl);
        }
    }

    // service workers must show an notification when push received
    // without this waitUntil the notification will show as
    // "This site has been updated in the background"
    event.waitUntil(notify);
});

function generateId() {
    let base36Date = Date.now().toString(36);
    return base36Date + Math.floor((Math.random() * 100000)).toString(36);
};
