// Tests for the meeting rules in server/src/rooms.js — who's host, who may
// speak, raised hands, the co-host, the waiting room, breakout rooms and
// rejoining. These are the heart of Turnly: if one breaks, meetings break.
//
// Run them with:  npm test   (Node's own test runner — nothing to install)
//
// rooms.js keeps every room in one in-memory map, so each test makes its own
// room with a fresh id (newRoom below) and they never see each other.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, ROLES } from '@listen/shared';
import {
  addChatMessage,
  addParticipant,
  addWaiting,
  admitWaiting,
  clearFloor,
  createPass,
  captionsOn,
  deleteChatMessage,
  mayCaption,
  setCaptionWatcher,
  demoteCohost,
  isChatMuted,
  setChatMuted,
  snapshot,
  denyWaiting,
  editChatMessage,
  findTicket,
  getRoom,
  grantFloor,
  lowerHand,
  makeHost,
  markAway,
  moveParticipant,
  passFloor,
  promoteCohost,
  raiseHand,
  rekey,
  removeParticipant,
  removeWaiting,
  reorderQueue,
  revokeFloor,
  setMode,
  setRole,
  setSharing,
  setSpeaking,
  ticketOf,
  unsendChatMessage,
  usePass,
} from '../src/rooms.js';

// --- helpers ------------------------------------------------------------------

let counter = 0;
const uid = (prefix) => `${prefix}-${++counter}`;

/** A room with these people in it (first is host). Returns { id, room, ids }. */
function newRoom(...names) {
  const id = uid('room');
  const ids = names.map((name) => uid(name));
  ids.forEach((socketId, i) => addParticipant(id, socketId, names[i], null, 'Test meeting'));
  return { id, room: getRoom(id), ids };
}

const roleOf = (room, socketId) => room.participants[socketId]?.role;

/** A moderated room: host + three others (all listeners). */
function moderatedRoom() {
  const r = newRoom('host', 'ada', 'ben', 'cy');
  setMode(r.room, MODES.MODERATED);
  return r;
}

// --- joining ------------------------------------------------------------------

describe('joining a room', () => {
  test('the first person in is the host; everyone else a speaker (open room)', () => {
    const { room, ids } = newRoom('host', 'ada', 'ben');
    assert.equal(room.hostId, ids[0]);
    assert.equal(roleOf(room, ids[0]), ROLES.HOST);
    assert.equal(roleOf(room, ids[1]), ROLES.SPEAKER);
    assert.equal(roleOf(room, ids[2]), ROLES.SPEAKER);
  });

  test('a new room starts open and with its door locked', () => {
    const { room } = newRoom('host');
    assert.equal(room.mode, MODES.OPEN);
    assert.equal(room.locked, true);
  });

  test('only the creator names the meeting', () => {
    const id = uid('room');
    addParticipant(id, uid('host'), 'Host', null, 'Sunday study');
    addParticipant(id, uid('ada'), 'Ada', null, 'Renamed!');
    assert.equal(getRoom(id).title, 'Sunday study');
  });

  test('joining a moderated room makes you a listener', () => {
    const { id, room } = moderatedRoom();
    const late = uid('late');
    addParticipant(id, late, 'Late');
    assert.equal(roleOf(room, late), ROLES.LISTENER);
  });

  test('names are cleaned: blank becomes "Guest", long ones are cut to 60', () => {
    const id = uid('room');
    const blank = uid('blank');
    const long = uid('long');
    addParticipant(id, blank, '   ');
    addParticipant(id, long, 'x'.repeat(200));
    assert.equal(getRoom(id).participants[blank].name, 'Guest');
    assert.equal(getRoom(id).participants[long].name.length, 60);
  });

  test('everyone gets their own secret rejoin ticket', () => {
    const { room, ids } = newRoom('host', 'ada');
    assert.ok(ticketOf(room, ids[0]));
    assert.notEqual(ticketOf(room, ids[0]), ticketOf(room, ids[1]));
  });
});

// --- open / moderated ---------------------------------------------------------

describe('open and moderated mode', () => {
  test('moderated: everyone but the host becomes a listener', () => {
    const { room, ids } = newRoom('host', 'ada', 'ben');
    setMode(room, MODES.MODERATED);
    assert.equal(roleOf(room, ids[0]), ROLES.HOST);
    assert.equal(roleOf(room, ids[1]), ROLES.LISTENER);
    assert.equal(roleOf(room, ids[2]), ROLES.LISTENER);
  });

  test('back to open: everyone is a speaker again', () => {
    const { room, ids } = moderatedRoom();
    setMode(room, MODES.OPEN);
    assert.equal(roleOf(room, ids[1]), ROLES.SPEAKER);
  });

  test('changing mode empties the line of raised hands', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    setMode(room, MODES.OPEN);
    assert.deepEqual(room.queue, []);
  });

  test('an unknown mode is ignored', () => {
    const { room } = newRoom('host');
    setMode(room, 'chaos');
    assert.equal(room.mode, MODES.OPEN);
  });
});

// --- raised hands -------------------------------------------------------------

describe('raised hands', () => {
  test('listeners join the line in the order they raise their hands', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[2]);
    raiseHand(room, ids[1]);
    assert.deepEqual(room.queue, [ids[2], ids[1]]);
  });

  test('raising twice does not put you in line twice', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    raiseHand(room, ids[1]);
    assert.deepEqual(room.queue, [ids[1]]);
  });

  test('no hands in an open room, and not for speakers or the host', () => {
    const open = newRoom('host', 'ada');
    raiseHand(open.room, open.ids[1]);
    assert.deepEqual(open.room.queue, []);

    const { room, ids } = moderatedRoom();
    grantFloor(room, ids[1]); // now a speaker
    raiseHand(room, ids[1]);
    raiseHand(room, ids[0]); // the host
    assert.deepEqual(room.queue, []);
  });

  test('lowering a hand takes you out of the line', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    raiseHand(room, ids[2]);
    lowerHand(room, ids[1]);
    assert.deepEqual(room.queue, [ids[2]]);
  });

  test('the host can reorder the line', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    raiseHand(room, ids[2]);
    reorderQueue(room, [ids[2], ids[1]]);
    assert.deepEqual(room.queue, [ids[2], ids[1]]);
  });

  test('a reorder that adds, drops or repeats someone is refused', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    raiseHand(room, ids[2]);
    const before = [...room.queue];
    reorderQueue(room, [ids[1]]); // someone missing
    reorderQueue(room, [ids[1], ids[1]]); // a repeat
    reorderQueue(room, [ids[1], ids[3]]); // someone not in line
    reorderQueue(room, 'nonsense');
    assert.deepEqual(room.queue, before);
  });
});

// --- the floor ----------------------------------------------------------------

describe('giving and taking the floor', () => {
  test('granting the floor makes a listener a speaker and takes them out of line', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    grantFloor(room, ids[1]);
    assert.equal(roleOf(room, ids[1]), ROLES.SPEAKER);
    assert.deepEqual(room.queue, []);
  });

  test('several people can hold the floor at once', () => {
    const { room, ids } = moderatedRoom();
    grantFloor(room, ids[1]);
    grantFloor(room, ids[2]);
    assert.equal(roleOf(room, ids[1]), ROLES.SPEAKER);
    assert.equal(roleOf(room, ids[2]), ROLES.SPEAKER);
  });

  test('taking the floor back makes a speaker a listener again', () => {
    const { room, ids } = moderatedRoom();
    grantFloor(room, ids[1]);
    revokeFloor(room, ids[1]);
    assert.equal(roleOf(room, ids[1]), ROLES.LISTENER);
  });

  test('nobody can take the host off the floor', () => {
    const { room, ids } = moderatedRoom();
    revokeFloor(room, ids[0]);
    setRole(room, ids[0], ROLES.LISTENER);
    assert.equal(roleOf(room, ids[0]), ROLES.HOST);
  });

  test('clear floor: every speaker becomes a listener, the line stays', () => {
    const { room, ids } = moderatedRoom();
    grantFloor(room, ids[1]);
    grantFloor(room, ids[2]);
    raiseHand(room, ids[3]);
    clearFloor(room);
    assert.equal(roleOf(room, ids[1]), ROLES.LISTENER);
    assert.equal(roleOf(room, ids[2]), ROLES.LISTENER);
    assert.equal(roleOf(room, ids[0]), ROLES.HOST);
    assert.deepEqual(room.queue, [ids[3]]);
  });

  test('pass the mic: the speaker steps down and the first hand gets the floor', () => {
    const { room, ids } = moderatedRoom();
    grantFloor(room, ids[1]);
    raiseHand(room, ids[2]);
    raiseHand(room, ids[3]);
    const result = passFloor(room, ids[1]);
    assert.deepEqual(result, { passed: true, next: ids[2] });
    assert.equal(roleOf(room, ids[1]), ROLES.LISTENER);
    assert.equal(roleOf(room, ids[2]), ROLES.SPEAKER);
    assert.deepEqual(room.queue, [ids[3]]);
  });

  test('pass the mic with nobody waiting: you just step down', () => {
    const { room, ids } = moderatedRoom();
    grantFloor(room, ids[1]);
    assert.deepEqual(passFloor(room, ids[1]), { passed: true, next: null });
    assert.equal(roleOf(room, ids[1]), ROLES.LISTENER);
  });

  test('only a speaker can pass the mic', () => {
    const { room, ids } = moderatedRoom();
    assert.deepEqual(passFloor(room, ids[1]), { passed: false, next: null });
  });
});

// --- co-host -----------------------------------------------------------------

describe('co-host', () => {
  test('the host can make one co-host, who leaves the line', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    promoteCohost(room, ids[1]);
    assert.equal(room.cohostId, ids[1]);
    assert.equal(roleOf(room, ids[1]), ROLES.COHOST);
    assert.deepEqual(room.queue, []);
  });

  test('a new co-host replaces the old one, who goes back to normal', () => {
    const { room, ids } = moderatedRoom();
    promoteCohost(room, ids[1]);
    promoteCohost(room, ids[2]);
    assert.equal(room.cohostId, ids[2]);
    assert.equal(roleOf(room, ids[1]), ROLES.LISTENER);
  });

  test('the co-host keeps their role when the mode flips', () => {
    const { room, ids } = newRoom('host', 'ada');
    promoteCohost(room, ids[1]);
    setMode(room, MODES.MODERATED);
    setMode(room, MODES.OPEN);
    assert.equal(roleOf(room, ids[1]), ROLES.COHOST);
  });

  test('removing the co-host makes them normal for the mode', () => {
    const { room, ids } = moderatedRoom();
    promoteCohost(room, ids[1]);
    demoteCohost(room, ids[1]);
    assert.equal(room.cohostId, null);
    assert.equal(roleOf(room, ids[1]), ROLES.LISTENER);
  });

  test('the host can’t be made co-host', () => {
    const { room, ids } = newRoom('host', 'ada');
    promoteCohost(room, ids[0]);
    assert.equal(room.cohostId, null);
    assert.equal(roleOf(room, ids[0]), ROLES.HOST);
  });

  test('a fixed room’s owner arriving takes over as host', () => {
    const { room, ids } = moderatedRoom();
    makeHost(room, ids[2]);
    assert.equal(room.hostId, ids[2]);
    assert.equal(roleOf(room, ids[2]), ROLES.HOST);
    assert.equal(roleOf(room, ids[0]), ROLES.LISTENER); // the stand-in host
  });
});

// --- leaving + who takes over ---------------------------------------------------

describe('leaving and who takes over', () => {
  test('when the host leaves, the co-host takes over', () => {
    const { room, ids } = newRoom('host', 'ada', 'ben');
    promoteCohost(room, ids[2]);
    removeParticipant(ids[0]);
    assert.equal(room.hostId, ids[2]);
    assert.equal(roleOf(room, ids[2]), ROLES.HOST);
    assert.equal(room.cohostId, null);
  });

  test('with no co-host, the next person to have joined takes over', () => {
    const { room, ids } = newRoom('host', 'ada', 'ben');
    removeParticipant(ids[0]);
    assert.equal(room.hostId, ids[1]);
    assert.equal(roleOf(room, ids[1]), ROLES.HOST);
  });

  test('leaving takes you out of the line and the talking list', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    setSpeaking(room, ids[0], true);
    removeParticipant(ids[1]);
    removeParticipant(ids[0]);
    assert.deepEqual(room.queue, []);
    assert.deepEqual(room.speaking, []);
  });

  test('the last one out closes the room', () => {
    const { id, ids } = newRoom('host');
    const result = removeParticipant(ids[0]);
    assert.equal(result.room, null);
    assert.equal(getRoom(id), null);
  });

  test('last one out with someone knocking: they come in as the new host', () => {
    const { id, room, ids } = newRoom('host');
    const knocker = uid('knocker');
    addWaiting(room, knocker, 'Knocker');
    const result = removeParticipant(ids[0]);
    assert.equal(result.admitted, knocker);
    assert.equal(getRoom(id).hostId, knocker);
  });

  test('someone who isn’t in any room: nothing happens', () => {
    assert.equal(removeParticipant(uid('nobody')), null);
  });
});

// --- waiting room ---------------------------------------------------------------

describe('waiting room', () => {
  test('someone knocking is not in the room yet', () => {
    const { room } = newRoom('host');
    const knocker = uid('knocker');
    addWaiting(room, knocker, 'Knocker');
    assert.ok(room.waiting[knocker]);
    assert.equal(room.participants[knocker], undefined);
  });

  test('letting them in gives them the role for the room’s mode', () => {
    const { room } = moderatedRoom();
    const knocker = uid('knocker');
    addWaiting(room, knocker, 'Knocker');
    admitWaiting(room, knocker);
    assert.equal(room.waiting[knocker], undefined);
    assert.equal(roleOf(room, knocker), ROLES.LISTENER);
  });

  test('turning them away removes them; admitting a non-knocker does nothing', () => {
    const { room } = newRoom('host');
    const knocker = uid('knocker');
    addWaiting(room, knocker, 'Knocker');
    denyWaiting(room, knocker);
    assert.equal(room.waiting[knocker], undefined);
    assert.equal(admitWaiting(room, knocker), null);
  });

  test('a knocker who gives up is found and removed', () => {
    const { id, room } = newRoom('host');
    const knocker = uid('knocker');
    addWaiting(room, knocker, 'Knocker');
    assert.equal(removeWaiting(knocker), id);
    assert.equal(room.waiting[knocker], undefined);
  });
});

// --- talking + screen sharing ---------------------------------------------------

describe('talking and screen sharing', () => {
  test('the last person to start talking is the active speaker', () => {
    const { room, ids } = newRoom('host', 'ada');
    assert.equal(setSpeaking(room, ids[0], true), true);
    assert.equal(setSpeaking(room, ids[1], true), true);
    assert.deepEqual(room.speaking, [ids[0], ids[1]]);
    assert.equal(setSpeaking(room, ids[1], true), false); // already talking
  });

  test('a listener can’t fake the green "speaking" glow', () => {
    const { id, room, ids } = moderatedRoom();
    setSpeaking(room, ids[1], true); // a hand-rolled client claiming to talk
    assert.equal(snapshot(id).activeSpeakerId, null);
  });

  test('a listener can’t become the active speaker', () => {
    const { room, ids } = moderatedRoom();
    assert.equal(setSpeaking(room, ids[1], true), false);
    assert.deepEqual(room.speaking, []);
  });

  test('losing the floor stops you talking and stops your screen share', () => {
    const { room, ids } = moderatedRoom();
    grantFloor(room, ids[1]);
    setSpeaking(room, ids[1], true);
    setSharing(room, ids[1], true, 'screen-1');
    revokeFloor(room, ids[1]);
    assert.deepEqual(room.speaking, []);
    assert.equal(room.sharing[ids[1]], undefined);
  });

  test('in a moderated room a listener can’t start sharing', () => {
    const { room, ids } = moderatedRoom();
    setSharing(room, ids[1], true, 'screen-1');
    assert.equal(room.sharing[ids[1]], undefined);
  });

  test('a new presenter bumps the old one', () => {
    const { room, ids } = newRoom('host', 'ada');
    setSharing(room, ids[0], true, 'screen-a');
    const bumped = setSharing(room, ids[1], true, 'screen-b');
    assert.equal(bumped, ids[0]);
    assert.deepEqual(room.sharing, { [ids[1]]: 'screen-b' });
  });
});

// --- chat ---------------------------------------------------------------------

describe('chat', () => {
  const msg = (id, from, kind = 'text') => ({ id, from, kind, text: 'hi', at: Date.now() });

  test('you can edit and unsend only your own messages', () => {
    const { room, ids } = newRoom('host', 'ada');
    addChatMessage(room, msg('m1', ids[1]));
    assert.equal(editChatMessage(room, ids[0], 'm1', 'hacked'), null);
    assert.equal(unsendChatMessage(room, ids[0], 'm1'), false);
    assert.equal(editChatMessage(room, ids[1], 'm1', 'edited').text, 'edited');
    assert.equal(unsendChatMessage(room, ids[1], 'm1'), true);
    assert.equal(room.chat.length, 0);
  });

  test('stickers and files can’t be edited', () => {
    const { room, ids } = newRoom('host');
    addChatMessage(room, msg('s1', ids[0], 'sticker'));
    assert.equal(editChatMessage(room, ids[0], 's1', 'x'), null);
  });

  test('a moderator can delete anyone’s message (the server checks who asks)', () => {
    const { room, ids } = newRoom('host', 'ada');
    addChatMessage(room, msg('m1', ids[1]));
    assert.equal(deleteChatMessage(room, 'm1').from, ids[1]);
    assert.equal(room.chat.length, 0);
    assert.equal(deleteChatMessage(room, 'm1'), null); // already gone
  });

  test('a muted person’s chat shows in the room state; unmuting clears it', () => {
    const { id, room, ids } = newRoom('host', 'ada');
    assert.equal(setChatMuted(room, ids[1], true), true);
    assert.equal(isChatMuted(room, ids[1]), true);
    assert.deepEqual(snapshot(id).chatMuted, [ids[1]]);
    setChatMuted(room, ids[1], false);
    assert.equal(isChatMuted(room, ids[1]), false);
  });

  test('the host’s and co-host’s chat can’t be muted', () => {
    const { room, ids } = newRoom('host', 'ada');
    promoteCohost(room, ids[1]);
    assert.equal(setChatMuted(room, ids[0], true), false);
    assert.equal(setChatMuted(room, ids[1], true), false);
  });

  test('being made co-host lifts a chat mute', () => {
    const { room, ids } = newRoom('host', 'ada');
    setChatMuted(room, ids[1], true);
    promoteCohost(room, ids[1]);
    assert.equal(isChatMuted(room, ids[1]), false);
  });

  test('a chat mute survives reconnecting, leaving + rejoining, and breakouts', () => {
    const { id, room, ids } = newRoom('host', 'ada', 'ben');
    setChatMuted(room, ids[1], true);
    const fresh = uid('ada-again');
    rekey(room, ids[1], fresh); // reconnect
    assert.equal(isChatMuted(room, fresh), true);

    createPass(room, id, fresh); // leave on purpose…
    const ticket = ticketOf(room, fresh);
    removeParticipant(fresh);
    const back = uid('ada-back');
    usePass(ticket, back); // …and rejoin
    assert.equal(isChatMuted(room, back), true);

    const breakoutId = uid('breakout');
    moveParticipant(id, breakoutId, ids[2]); // Ben goes first, so he hosts it
    const to = moveParticipant(id, breakoutId, back);
    assert.equal(isChatMuted(to, back), true);
  });

  test('the room keeps only the last 100 messages', () => {
    const { room, ids } = newRoom('host');
    for (let i = 0; i < 130; i += 1) addChatMessage(room, msg(`m${i}`, ids[0]));
    assert.equal(room.chat.length, 100);
    assert.equal(room.chat[0].id, 'm30');
  });
});

// --- live captions ----------------------------------------------------------------

describe('live captions', () => {
  test('captions are on while anyone wants them, and the room state says so', () => {
    const { id, room, ids } = newRoom('host', 'ada');
    assert.equal(captionsOn(room), false);
    setCaptionWatcher(room, ids[1], true);
    assert.equal(snapshot(id).captionsOn, true);
    setCaptionWatcher(room, ids[1], false);
    assert.equal(snapshot(id).captionsOn, false);
  });

  test('nobody’s speech is shown while captions are off', () => {
    const { room, ids } = newRoom('host', 'ada');
    assert.equal(mayCaption(room, ids[0]), false);
  });

  test('in a moderated room only people who may speak are captioned', () => {
    const { room, ids } = moderatedRoom();
    setCaptionWatcher(room, ids[3], true);
    assert.equal(mayCaption(room, ids[0]), true); // the host
    assert.equal(mayCaption(room, ids[1]), false); // a listener
    grantFloor(room, ids[1]);
    assert.equal(mayCaption(room, ids[1]), true); // now a speaker
  });

  test('wanting captions survives a reconnect; leaving turns it off', () => {
    const { room, ids } = newRoom('host', 'ada');
    setCaptionWatcher(room, ids[1], true);
    const fresh = uid('ada-again');
    rekey(room, ids[1], fresh);
    assert.equal(captionsOn(room), true);
    removeParticipant(fresh);
    assert.equal(captionsOn(room), false);
  });
});

// --- reconnecting + rejoining -----------------------------------------------------

describe('reconnecting and rejoining', () => {
  test('a dropped connection keeps its seat: the new connection takes it over', () => {
    const { room, ids } = moderatedRoom();
    raiseHand(room, ids[1]);
    const ticket = ticketOf(room, ids[1]);
    markAway(room, ids[1]);
    assert.ok(room.away[ids[1]]);

    const found = findTicket(ticket);
    assert.equal(found.oldId, ids[1]);
    const fresh = uid('ada-again');
    rekey(room, ids[1], fresh);
    assert.equal(roleOf(room, fresh), ROLES.LISTENER);
    assert.deepEqual(room.queue, [fresh]); // same place in line
    assert.equal(room.away[fresh], undefined);
    assert.equal(ticketOf(room, fresh), ticket);
  });

  test('the host reconnecting stays host', () => {
    const { room, ids } = newRoom('host', 'ada');
    const fresh = uid('host-again');
    rekey(room, ids[0], fresh);
    assert.equal(room.hostId, fresh);
  });

  test('leaving on purpose then rejoining gives you your old role back', () => {
    const { id, room, ids } = moderatedRoom();
    grantFloor(room, ids[1]); // Ada had the floor
    const pass = createPass(room, id, ids[1]);
    const ticket = ticketOf(room, ids[1]);
    removeParticipant(ids[1]);
    assert.ok(pass);

    const fresh = uid('ada-back');
    const back = usePass(ticket, fresh);
    assert.equal(back.roomId, id);
    assert.equal(roleOf(room, fresh), ROLES.SPEAKER);
  });

  test('a rejoin pass works only once', () => {
    const { id, room, ids } = newRoom('host', 'ada');
    createPass(room, id, ids[1]);
    const ticket = ticketOf(room, ids[1]);
    removeParticipant(ids[1]);
    assert.ok(usePass(ticket, uid('ada-1')));
    assert.equal(usePass(ticket, uid('ada-2')), null);
  });

  test('the host leaving and rejoining takes the room back', () => {
    const { id, room, ids } = newRoom('host', 'ada');
    createPass(room, id, ids[0]);
    const ticket = ticketOf(room, ids[0]);
    removeParticipant(ids[0]); // Ada stands in as host
    assert.equal(room.hostId, ids[1]);

    const fresh = uid('host-back');
    usePass(ticket, fresh);
    assert.equal(room.hostId, fresh);
    assert.equal(roleOf(room, ids[1]), ROLES.SPEAKER);
  });
});

// --- breakout rooms ---------------------------------------------------------------

describe('breakout rooms', () => {
  test('moving someone keeps their ticket and mic state', () => {
    const { id, room, ids } = newRoom('host', 'ada', 'ben');
    room.mics[ids[1]] = false;
    const ticket = ticketOf(room, ids[1]);
    const breakoutId = uid('breakout');
    const to = moveParticipant(id, breakoutId, ids[1], { title: 'Room 1' });
    assert.equal(room.participants[ids[1]], undefined);
    assert.equal(ticketOf(to, ids[1]), ticket);
    assert.equal(to.mics[ids[1]], false);
    assert.equal(to.title, 'Room 1');
  });

  test('the first one into a breakout room is its host; it has no door', () => {
    const { id, ids } = newRoom('host', 'ada', 'ben');
    const breakoutId = uid('breakout');
    const to = moveParticipant(id, breakoutId, ids[1]);
    moveParticipant(id, breakoutId, ids[2]);
    assert.equal(to.hostId, ids[1]);
    assert.equal(roleOf(to, ids[2]), ROLES.SPEAKER);
    assert.equal(to.locked, false);
  });

  test('the main room’s host moving out hands it to the next person', () => {
    const { id, room, ids } = newRoom('host', 'ada');
    moveParticipant(id, uid('breakout'), ids[0]);
    assert.equal(room.hostId, ids[1]);
  });

  test('moving someone who isn’t there does nothing', () => {
    const { id } = newRoom('host');
    assert.equal(moveParticipant(id, uid('breakout'), uid('ghost')), null);
  });
});

// --- a fixed room's owner vs rejoin passes -----------------------------------------
// (A fixed room = a claimed name or scheduled meeting; its owner joins with
// the host key, which calls makeHost.)

describe('a rejoin pass never outranks the owner', () => {
  /** A fixed room: a guest got the host role first, then the owner arrived. */
  function fixedRoom() {
    const r = newRoom('guest', 'owner', 'ada');
    makeHost(r.room, r.ids[1]); // the owner arrives with the host key
    return r;
  }

  test('a stand-in host who left and rejoins does not take the room from the owner', () => {
    const { id, room, ids } = newRoom('guest', 'ada');
    // The guest is host until the owner turns up…
    createPass(room, id, ids[0]);
    const ticket = ticketOf(room, ids[0]);
    removeParticipant(ids[0]); // …the guest leaves; ada inherits the host role
    const owner = uid('owner');
    addParticipant(id, owner, 'owner', null, 'Test meeting');
    makeHost(room, owner); // the owner arrives with the host key
    const back = uid('guest-back');
    usePass(ticket, back); // the guest rejoins within the minute
    assert.equal(room.hostId, owner);
    assert.notEqual(roleOf(room, back), ROLES.HOST);
  });

  test('the owner’s own pass still gives them the host role back', () => {
    const { id, room, ids } = fixedRoom();
    createPass(room, id, ids[1]);
    const ticket = ticketOf(room, ids[1]);
    removeParticipant(ids[1]); // the owner steps out; someone else inherits
    assert.notEqual(room.hostId, ids[1]);
    const back = uid('owner-back');
    usePass(ticket, back);
    assert.equal(room.hostId, back);
    assert.equal(room.ownerId, back);
  });

  test('a fixed room that closed reopens only for its owner', () => {
    const { id, room, ids } = fixedRoom();
    // Everyone but the stand-in leaves; then the stand-in leaves too.
    removeParticipant(ids[1]);
    removeParticipant(ids[2]);
    createPass(room, id, ids[0]);
    const ticket = ticketOf(room, ids[0]);
    removeParticipant(ids[0]); // the room closes
    assert.equal(getRoom(id), null);
    assert.deepEqual(usePass(ticket, uid('guest-back')), { error: 'host-gone' });
    assert.equal(getRoom(id), null); // still closed: they join and wait for the owner
  });

  test('the owner can reopen their closed room with their pass', () => {
    const { id, room, ids } = fixedRoom();
    removeParticipant(ids[0]);
    removeParticipant(ids[2]);
    createPass(room, id, ids[1]);
    const ticket = ticketOf(room, ids[1]);
    removeParticipant(ids[1]);
    const back = uid('owner-back');
    const result = usePass(ticket, back);
    assert.equal(result.room.hostId, back);
    assert.equal(result.room.fixed, true);
  });

  test('an ordinary (not fixed) room still reopens for whoever rejoins', () => {
    const { id, room, ids } = newRoom('host');
    createPass(room, id, ids[0]);
    const ticket = ticketOf(room, ids[0]);
    removeParticipant(ids[0]);
    const back = uid('host-back');
    assert.equal(usePass(ticket, back).room.hostId, back);
  });
});

// --- the main room emptying during breakouts -------------------------------------

describe('breakouts when the main room empties', () => {
  test('the main room is kept, and the caller is told to bring everyone back', () => {
    const { id, room, ids } = newRoom('host', 'ada', 'ben');
    const breakoutId = `${id}~1`;
    room.breakouts = { ids: [breakoutId], endsAt: null };
    moveParticipant(id, breakoutId, ids[1], { breakoutOf: id });
    moveParticipant(id, breakoutId, ids[2], { breakoutOf: id });
    const result = removeParticipant(ids[0]); // the host leaves the main room
    assert.equal(result.emptyDuringBreakouts, true);
    assert.equal(getRoom(id), room); // not deleted
    // Bringing them back (what endBreakouts does): the first one back hosts.
    const main = moveParticipant(breakoutId, id, ids[1]);
    assert.equal(main.hostId, ids[1]);
  });

  test('without breakouts, an empty room still closes as before', () => {
    const { id, ids } = newRoom('host');
    assert.equal(removeParticipant(ids[0]).room, null);
    assert.equal(getRoom(id), null);
  });
});
