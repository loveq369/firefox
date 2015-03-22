/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: sw=4 ts=4 et :
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef dom_plugins_PluginProcessParent_h
#define dom_plugins_PluginProcessParent_h 1

#include "mozilla/Attributes.h"
#include "base/basictypes.h"

#include "base/file_path.h"
#include "base/task.h"
#include "base/thread.h"
#include "base/waitable_event.h"
#include "chrome/common/child_process_host.h"

#include "mozilla/ipc/GeckoChildProcessHost.h"
#include "mozilla/UniquePtr.h"
#include "nsCOMPtr.h"
#include "nsIRunnable.h"

namespace mozilla {
namespace plugins {

class LaunchCompleteTask : public Task
{
public:
    LaunchCompleteTask()
        : mLaunchSucceeded(false)
    {
    }

    void SetLaunchSucceeded() { mLaunchSucceeded = true; }

protected:
    bool mLaunchSucceeded;
};

class PluginProcessParent : public mozilla::ipc::GeckoChildProcessHost
{
public:
    explicit PluginProcessParent(const std::string& aPluginFilePath);
    ~PluginProcessParent();

    /**
     * Launch the plugin process. If the process fails to launch,
     * this method will return false.
     *
     * @param aLaunchCompleteTask Task that is executed on the main
     * thread once the asynchonous launch has completed.
     * @param aEnableSandbox Enables a process sandbox if one is available for
     * this platform/build. Will assert if true passed and one is not available.
     */
    bool Launch(UniquePtr<LaunchCompleteTask> aLaunchCompleteTask = UniquePtr<LaunchCompleteTask>(),
                bool aEnableSandbox = false);

    void Delete();

    virtual bool CanShutdown() MOZ_OVERRIDE
    {
        return true;
    }

    const std::string& GetPluginFilePath() { return mPluginFilePath; }

    using mozilla::ipc::GeckoChildProcessHost::GetShutDownEvent;
    using mozilla::ipc::GeckoChildProcessHost::GetChannel;

    void SetCallRunnableImmediately(bool aCallImmediately);
    virtual bool WaitUntilConnected(int32_t aTimeoutMs = 0) MOZ_OVERRIDE;

    virtual void OnChannelConnected(int32_t peer_pid) MOZ_OVERRIDE;
    virtual void OnChannelError() MOZ_OVERRIDE;

    bool IsConnected();

private:
    void RunLaunchCompleteTask();

    std::string mPluginFilePath;
    UniquePtr<LaunchCompleteTask> mLaunchCompleteTask;
    MessageLoop* mMainMsgLoop;
    bool mRunCompleteTaskImmediately;

    DISALLOW_EVIL_CONSTRUCTORS(PluginProcessParent);
};


} // namespace plugins
} // namespace mozilla

#endif // ifndef dom_plugins_PluginProcessParent_h