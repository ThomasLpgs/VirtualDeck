// The PC's microphones (src/microphone.js), with a fake Windows: no microphone is really muted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMicrophone } = require('../src/microphone');

// mics: muted state of each microphone, changed in place.
function fakeAudio(mics) {
  const audio = {
    eachMicrophone: (fn) =>
      mics.map((_, i) =>
        fn({
          muted: () => mics[i],
          setMuted: (muted) => (mics[i] = muted),
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
  assert.equal(microphone.isMuted(), true);
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
  assert.equal(microphone.isMuted(), null);
  assert.throws(() => microphone.set(), { code: 'noMic' });
});
