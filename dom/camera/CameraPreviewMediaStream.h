/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_CAMERA_CAMERAPREVIEWMEDIASTREAM_H
#define DOM_CAMERA_CAMERAPREVIEWMEDIASTREAM_H

#include "VideoFrameContainer.h"
#include "MediaStreamGraph.h"
#include "mozilla/Mutex.h"

namespace mozilla {

class FakeMediaStreamGraph : public MediaStreamGraph
{
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(FakeMediaStreamGraph)
public:
  FakeMediaStreamGraph()
    : MediaStreamGraph(16000)
  {
  }

  virtual void
  DispatchToMainThreadAfterStreamStateUpdate(already_AddRefed<nsIRunnable> aRunnable) MOZ_OVERRIDE;

protected:
  ~FakeMediaStreamGraph()
  {}
};

/**
 * This is a stream for camera preview.
 *
 * XXX It is a temporary fix of SourceMediaStream.
 * A camera preview requests no delay and no buffering stream,
 * but the SourceMediaStream does not support it.
 */
class CameraPreviewMediaStream : public MediaStream
{
  typedef mozilla::layers::Image Image;

public:
  explicit CameraPreviewMediaStream(DOMMediaStream* aWrapper);

  virtual void AddAudioOutput(void* aKey) MOZ_OVERRIDE;
  virtual void SetAudioOutputVolume(void* aKey, float aVolume) MOZ_OVERRIDE;
  virtual void RemoveAudioOutput(void* aKey) MOZ_OVERRIDE;
  virtual void AddVideoOutput(VideoFrameContainer* aContainer) MOZ_OVERRIDE;
  virtual void RemoveVideoOutput(VideoFrameContainer* aContainer) MOZ_OVERRIDE;
  virtual void ChangeExplicitBlockerCount(int32_t aDelta) MOZ_OVERRIDE;
  virtual void AddListener(MediaStreamListener* aListener) MOZ_OVERRIDE;
  virtual void RemoveListener(MediaStreamListener* aListener) MOZ_OVERRIDE;
  virtual void Destroy() MOZ_OVERRIDE;
  void OnPreviewStateChange(bool aActive);

  void Invalidate();

  // Call these on any thread.
  void SetCurrentFrame(const gfxIntSize& aIntrinsicSize, Image* aImage);
  void ClearCurrentFrame();
  void RateLimit(bool aLimit);

protected:
  // mMutex protects all the class' fields.
  // This class is not registered to MediaStreamGraph.
  // It needs to protect all the fields.
  Mutex mMutex;
  int32_t mInvalidatePending;
  uint32_t mDiscardedFrames;
  bool mRateLimit;
  bool mTrackCreated;
  nsRefPtr<FakeMediaStreamGraph> mFakeMediaStreamGraph;
};

}

#endif // DOM_CAMERA_CAMERAPREVIEWMEDIASTREAM_H