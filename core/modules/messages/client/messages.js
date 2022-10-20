import { meteorCallWithPromise } from '../../../client/helpers';
import { canSubscribeToNotifications } from '../misc';

const messageMaxLength = 4096;

const ignoreChannelAutoSwitch = () => !Session.get('console') || (Session.get('messagesChannel') || '').includes('qst_');

messagesModule = {
  handleMessagesSubscribe: undefined,
  channel: undefined,
  lastZoneEntered: undefined,

  init() {
    Session.set('messagesChannel', undefined);

    const onZoneEntered = event => {
      if (ignoreChannelAutoSwitch()) return;

      const { zone } = event.detail;
      this.lastZoneEntered = zone._id;
      this.changeMessagesChannel(zone._id);
    };

    const onZoneLeft = event => {
      if (ignoreChannelAutoSwitch()) return;

      const { zone } = event.detail;
      if (zone._id !== this.lastZoneEntered) return;

      const nearUsersChannel = nearUserIdsToString();
      if (nearUsersChannel.length) this.changeMessagesChannel(nearUsersChannel);
      else this.stopListeningMessagesChannel();

      this.lastZoneEntered = undefined;
    };

    window.addEventListener(eventTypes.onZoneEntered, onZoneEntered);
    window.addEventListener(eventTypes.onZoneLeft, onZoneLeft);
  },

  autoSelectChannel() {
    if (userProximitySensor.isNearSomeone()) this.changeMessagesChannel(nearUserIdsToString());
    else if (zoneManager.activeZone) this.changeMessagesChannel(zoneManager.activeZone._id);
    else this.changeMessagesChannel(Meteor.user().profile.levelId);
  },

  changeMessagesChannel(channel) {
    if (!channel || channel === this.channel) return;

    this.stopListeningMessagesChannel();
    this.handleMessagesSubscribe = Meteor.subscribe('messages', channel);
    this.channel = channel;
    Session.set('messagesChannel', channel); // set console in the new channel
    this.markChannelAsRead(channel);
  },

  markChannelAsRead(channel) {
    if (canSubscribeToNotifications(channel)) {
      Meteor.call('messagesUpdateChannelLastSeenDate', channel, () => {
        const zone = Zones.findOne(channel);
        if (zone) zoneManager.destroyNewContentIndicator(zone);
      });
    } else if (channel.includes('qst_')) {
      const notification = Notifications.findOne({ $or: [{ questId: channel }, { channelId: channel }], userId: Meteor.userId() });
      if (notification && !notification.read) Notifications.update(notification._id, { $set: { read: true } });
    }
  },

  async sendWebRTCMessage(channel, content) {
    try {
      let showPopInOverEmitter = true;
      if (channel.includes('zon_')) await sendDataToUsersInZone('text', { content, channel }, Meteor.userId());
      else {
        const userIds = userProximitySensor.filterNearUsers(channel.split(';'));
        showPopInOverEmitter = !!userIds.length;
        await sendDataToUsers('text', { content, channel }, Meteor.userId(), userIds);
      }

      // simulate a message from himself to show a pop-in over user's head
      if (showPopInOverEmitter) userManager.onPeerDataReceived({ emitter: Meteor.userId(), data: { content, channel }, type: 'text' });
    } catch (err) {
      if (err.message !== 'no-targets') lp.notif.error(err);
    }
  },

  async sendMessage(channel, content, file) {
    if (content.length >= messageMaxLength) throw new Error(`The message is too long (> ${messageMaxLength} chars)`);
    content = lp.purify(content).trim();
    if (!content.length && !file) throw new Error(`Invalid content`);

    window.dispatchEvent(new CustomEvent(eventTypes.beforeSendingMessage, { detail: { channel, content } }));

    let messageId;
    try {
      messageId = await meteorCallWithPromise('sendMessage', channel, content, file?._id);
    } catch (err) {
      lp.notif.error('You are not authorized to speak here');
    }

    window.dispatchEvent(new CustomEvent(eventTypes.afterSendingMessage, { detail: { channel, messageId } }));

    this.markChannelAsRead(channel);
    if (!channel.includes('qst_') && content.length) this.sendWebRTCMessage(channel, content);

    return messageId;
  },

  stopListeningMessagesChannel() {
    this.channel = undefined;
    this.handleMessagesSubscribe?.stop();
    Session.set('messagesChannel', undefined);
  },
};
