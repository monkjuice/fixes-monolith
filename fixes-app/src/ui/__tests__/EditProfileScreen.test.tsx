import { act, fireEvent, screen } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import { ApiError } from '../../core/api/errors';
import { EditProfileScreen, UPLOAD_FAILED } from '../screens/profile/EditProfileScreen';
import { createFakeServices, TEST_USER } from './support/fakeServices';
import { renderScreen } from './support/renderScreen';

/** The picker and the native image pipeline are replaced; the screen's use of them is what is tested. */

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const mockSaved = { uri: 'file:///cache/ImageManipulator/avatar.jpg', width: 1024, height: 1024 };
const mockImage = { saveAsync: jest.fn(async () => mockSaved), release: jest.fn() };
const mockContext = {
  crop: jest.fn(),
  resize: jest.fn(),
  renderAsync: jest.fn(async () => mockImage),
  release: jest.fn(),
};

jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: jest.fn(() => mockContext) },
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));

const picker = jest.mocked(ImagePicker);

function picked(width: number, height: number): ImagePicker.ImagePickerResult {
  return { canceled: false, assets: [{ uri: 'file:///cache/ImagePicker/original.jpg', width, height }] };
}

function setUp() {
  const fake = createFakeServices({ status: 'ready', user: TEST_USER });
  renderScreen('EditProfile', EditProfileScreen, fake.services);
  return fake;
}

async function press(testID: string) {
  const element = await screen.findByTestId(testID);
  await act(async () => {
    fireEvent.press(element);
  });
}

describe('Edit profile (§14 avatar)', () => {
  afterEach(() => jest.clearAllMocks());

  it('square-crops and resizes the picked photo to a ≤ 1024 px JPEG 0.8, previews it, then uploads on Save', async () => {
    const fake = setUp();
    picker.launchImageLibraryAsync.mockResolvedValueOnce(picked(4000, 3000));
    await press('edit-profile-library');

    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsEditing: true, aspect: [1, 1], mediaTypes: 'images' }));
    // The library needs no permission; only the camera does.
    expect(picker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(mockContext.crop).toHaveBeenCalledWith({ originX: 500, originY: 0, width: 3000, height: 3000 });
    expect(mockContext.resize).toHaveBeenCalledWith({ width: 1024, height: 1024 });
    expect(mockImage.saveAsync).toHaveBeenCalledWith({ compress: 0.8, format: 'jpeg' });
    expect(mockContext.release).toHaveBeenCalled();
    expect(screen.getByTestId('edit-profile-preview-image', { includeHiddenElements: true }).props.source).toEqual({ uri: mockSaved.uri });
    expect(fake.session.api.uploadAvatar).not.toHaveBeenCalled();

    await press('edit-profile-save');
    expect(fake.session.api.uploadAvatar).toHaveBeenCalledWith(mockSaved.uri);
    expect(await screen.findByTestId('stub-Main')).toBeOnTheScreen();
    expect(screen.getByTestId('toast')).toHaveTextContent('Profile photo updated');
  });

  it("takes the new photo's URL into the session, so the screen shows it as the current photo next time", async () => {
    const fake = setUp();
    const updated = { ...TEST_USER, avatar_url: 'https://media.fixes.test/avatars/new-key.jpg' };
    fake.session.api.uploadAvatar.mockResolvedValueOnce({ user: updated });
    picker.launchImageLibraryAsync.mockResolvedValueOnce(picked(1024, 1024));
    await press('edit-profile-library');
    await press('edit-profile-save');
    expect(await screen.findByTestId('stub-Main')).toBeOnTheScreen();
    // The server stored the photo under a new URL and deleted the old one.
    expect(fake.session.updateUser).toHaveBeenCalledWith(updated);
  });

  it('shows the server reason or the legacy upload error, and keeps the preview for another try', async () => {
    const fake = setUp();
    picker.launchCameraAsync.mockResolvedValue(picked(800, 800));
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true, status: 'granted' as ImagePicker.PermissionStatus, expires: 'never' });
    await press('edit-profile-camera');
    // Already square and small: re-encoded only.
    expect(mockContext.crop).not.toHaveBeenCalled();
    expect(mockContext.resize).not.toHaveBeenCalled();
    expect(mockImage.saveAsync).toHaveBeenCalledWith({ compress: 0.8, format: 'jpeg' });

    fake.session.api.uploadAvatar.mockRejectedValueOnce(new ApiError({ status: 400, code: 'invalid_image', message: 'x' }));
    await press('edit-profile-save');
    expect(screen.getByTestId('edit-profile-error')).toHaveTextContent('This image could not be used. Choose another photo.');

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.session.api.uploadAvatar.mockRejectedValueOnce(new ApiError({ status: 403, code: 'forbidden', message: 'x' }));
    await press('edit-profile-save');
    warn.mockRestore();
    expect(screen.getByTestId('edit-profile-error')).toHaveTextContent(UPLOAD_FAILED);
    expect(screen.getByTestId('edit-profile-save')).toBeOnTheScreen();
  });

  it('explains a refused camera permission and offers the system settings', async () => {
    setUp();
    picker.requestCameraPermissionsAsync.mockResolvedValueOnce({
      granted: false,
      canAskAgain: false,
      status: 'denied' as ImagePicker.PermissionStatus,
      expires: 'never',
    });
    await press('edit-profile-camera');
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-profile-error')).toHaveTextContent('Fixes is not allowed to use the camera.', { exact: false });
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeOnTheScreen();
  });

  it('does nothing when picking is cancelled', async () => {
    const fake = setUp();
    picker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    await press('edit-profile-library');
    expect(screen.queryByTestId('edit-profile-save')).toBeNull();
    expect(screen.queryByTestId('edit-profile-error')).toBeNull();
    expect(fake.session.api.uploadAvatar).not.toHaveBeenCalled();
  });
});
