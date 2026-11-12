package com.archstone.connect;

import android.app.Application;

public class ArchstoneApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        // Firebase must be ready before a notification wakes the app.
        ArchstoneFirebase.start(this);
    }
}
