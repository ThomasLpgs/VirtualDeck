// The PC's microphones (src/microphone.js), with a fake Windows: no microphone is really muted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMicrophone } = require('../src/microphone');

// mics: muted state of each microphone, changed in place. The first one is Windows' default.
// refuses: index of a microphone that can't change (unplugged meanwhile).
function fakeAudio(mics, { refuses = -1 } = {}) {
  const names = ['Yeti', 'Headset', 'Webcam'];
  const audio = {
    eachMicrophone: (fn) =>
      mics.map((_, i) =>
        fn({
          id: `mic-${i}`,
          isDefault: i === 0,
          name: () => names[i],
          muted: () => mics[i],
          setMuted: (muted) => {
            if (i === refuses) throw new Error('unplugged');
            mics[i] = muted;
          },
        }),
      ),
  };
  return () => audio;
}

test('toggles every microphone of the PC at once', () => {
  const mics = [false, false];
  const microphone = createMicrophone({ system: fakeAudio(mics) });
  assert.equal(microphone.set('toggle'), true);
  assert.deepEqual(mics, [true, true]);
  assert.deepEqual(microphone.states(['']), { '': true });
  assert.equal(microphone.set(), false);
  assert.deepEqual(mics, [false, false]);
});

test('one microphone still on: toggle mutes them all', () => {
  const mics = [true, false];
  assert.equal(createMicrophone({ system: fakeAudio(mics) }).set('toggle'), true);
  assert.deepEqual(mics, [true, true]);
});

test('mute and unmute, whatever the state', () => {
  const mics = [true];
  const microphone = createMicrophone({ system: fakeAudio(mics) });
  assert.equal(microphone.set('mute'), true);
  assert.equal(microphone.set('unmute'), false);
  assert.equal(microphone.set('unmute'), false);
  assert.deepEqual(mics, [false]);
});

test('without a microphone', () => {
  const microphone = createMicrophone({ system: fakeAudio([]) });
  assert.deepEqual(microphone.states(['', 'default']), { '': null, default: null });
  assert.throws(() => microphone.set(), { code: 'noMic' });
  assert.throws(() => microphone.set('toggle', 'default'), { code: 'noMic' });
});

test('a microphone that refuses does not stop the others', () => {
  const mics = [false, false];
  const microphone = createMicrophone({ system: fakeAudio(mics, { refuses: 0 }) });
  assert.throws(() => microphone.set('mute'), { code: 'refused' });
  assert.deepEqual(mics, [false, true]);
});

test('lists the microphones by name, for the editor', () => {
  assert.deepEqual(createMicrophone({ system: fakeAudio([false, true]) }).list(), [
    { id: 'mic-0', name: 'Yeti', isDefault: true },
    { id: 'mic-1', name: 'Headset', isDefault: false },
  ]);
});

test('only the chosen microphone, or the default one', () => {
  const mics = [false, false, false];
  const microphone = createMicrophone({ system: fakeAudio(mics) });
  assert.equal(microphone.set('toggle', 'mic-1'), true);
  assert.deepEqual(mics, [false, true, false]);
  assert.equal(microphone.set('mute', 'default'), true);
  assert.deepEqual(mics, [true, true, false]);
  // A microphone muted alone keeps the "every microphone" key off.
  assert.deepEqual(microphone.states(['', 'default', 'mic-1', 'mic-2']), { '': false, default: true, 'mic-1': true, 'mic-2': false });
});

test('a chosen microphone that is unplugged', () => {
  const mics = [false];
  const microphone = createMicrophone({ system: fakeAudio(mics) });
  assert.throws(() => microphone.set('toggle', 'mic-7'), { code: 'notFound' });
  assert.deepEqual(microphone.states(['mic-7']), { 'mic-7': null });
  assert.deepEqual(mics, [false]);
});
