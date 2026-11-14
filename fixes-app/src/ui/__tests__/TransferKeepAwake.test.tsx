import { act, render } from '@testing-library/react-native';
import { useKeepAwake } from 'expo-keep-awake';

import type { OutgoingLinkPhase } from '../../core/linking/outgoing';
import { FixesProvider } from '../../hooks';
import { isTransferRunning, TransferKeepAwake } from '../components';
import { createFakeServices } from './support/fakeServices';

jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));

const mockedUseKeepAwake = jest.mocked(useKeepAwake);

describe('keeping the screen awake during a history transfer (§9 step 4)', () => {
  it.each<[OutgoingLinkPhase, boolean]>([
    ['idle', false],
    ['checking', true],
    ['certifying', true],
    ['sendingLink', true],
    ['syncing', true],
    ['preparing', true],
    ['sendingHistory', true],
    ['done', false],
    ['failed', false],
  ])('outgoing phase %s → %s', (phase, running) => {
    expect(isTransferRunning('idle', phase)).toBe(running);
  });

  it('holds the wake lock only while history is being received', async () => {
    const fake = createFakeServices({ status: 'needsLink' });
    render(
      <FixesProvider services={fake.services}>
        <TransferKeepAwake />
      </FixesProvider>,
    );
    expect(mockedUseKeepAwake).not.toHaveBeenCalled();
    await act(async () => {
      fake.messaging.incomingLink.update({ phase: 'receiving' });
    });
    expect(mockedUseKeepAwake).toHaveBeenCalledWith('fixes-history-transfer');
    mockedUseKeepAwake.mockClear();
    await act(async () => {
      fake.messaging.incomingLink.update({ phase: 'complete' });
    });
    expect(mockedUseKeepAwake).not.toHaveBeenCalled();
  });
});
