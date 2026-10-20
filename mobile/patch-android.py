#!/usr/bin/env python3
"""Applies the ERRS Lab Wall's Android settings on top of the project that
`npx cap add android` generates in CI: EPA icons, Android TV launcher and
banner, screen kept on, full-screen display, version and release signing.

Usage: python3 patch-android.py <versionName> <versionCode>
"""
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, 'android', 'app')
version_name, version_code = sys.argv[1], sys.argv[2]


def edit(path, fn):
    with open(path, encoding='utf-8') as f:
        src = f.read()
    out = fn(src)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(out)


# 1. icons and TV banner
res = os.path.join(A, 'src', 'main', 'res')
shutil.rmtree(os.path.join(res, 'mipmap-anydpi-v26'), ignore_errors=True)  # use the plain EPA icons
for root, _, files in os.walk(os.path.join(HERE, 'res')):
    rel = os.path.relpath(root, os.path.join(HERE, 'res'))
    for name in files:
        dest = os.path.join(res, rel)
        os.makedirs(dest, exist_ok=True)
        shutil.copyfile(os.path.join(root, name), os.path.join(dest, name))


# 2. manifest: TV launcher, banner, no touchscreen required
def manifest(src):
    if 'LEANBACK_LAUNCHER' not in src:
        src = src.replace('<category android:name="android.intent.category.LAUNCHER" />',
                          '<category android:name="android.intent.category.LAUNCHER" />\n'
                          '                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />', 1)
    if 'android:banner' not in src:
        src = src.replace('<application', '<application\n        android:banner="@drawable/banner"', 1)
    if 'android.software.leanback' not in src:
        src = src.replace('<application',
                          '<uses-feature android:name="android.software.leanback" android:required="false" />\n'
                          '    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />\n\n'
                          '    <application', 1)
    if 'LEANBACK_LAUNCHER' not in src or 'android:banner' not in src:
        raise SystemExit('manifest patch failed')
    return src


edit(os.path.join(A, 'src', 'main', 'AndroidManifest.xml'), manifest)

# 3. MainActivity: keep the screen on and hide the system bars
java_dir = os.path.join(A, 'src', 'main', 'java', 'lr', 'epa', 'errs', 'labwall')
os.makedirs(java_dir, exist_ok=True)
with open(os.path.join(java_dir, 'MainActivity.java'), 'w', encoding='utf-8') as f:
    f.write('''package lr.epa.errs.labwall;

import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
''')


# 4. version and release signing (keystore comes from the CI secrets)
def gradle(src):
    src = re.sub(r'versionCode \d+', 'versionCode ' + version_code, src, count=1)
    src = re.sub(r'versionName "[^"]*"', 'versionName "%s"' % version_name, src, count=1)
    if 'signingConfigs' not in src:
        src = src.replace('    buildTypes {', '''    signingConfigs {
        release {
            def ks = System.getenv("WALL_KEYSTORE")
            if (ks) {
                storeFile file(ks)
                storePassword System.getenv("WALL_KEYSTORE_PASSWORD")
                keyAlias System.getenv("WALL_KEY_ALIAS")
                keyPassword System.getenv("WALL_KEY_PASSWORD")
            }
        }
    }
    buildTypes {''', 1)
        src = re.sub(r'(release \{\n)(\s+minifyEnabled)', r'\1            signingConfig System.getenv("WALL_KEYSTORE") ? signingConfigs.release : signingConfigs.debug\n\2', src, count=1)
    if 'signingConfig System.getenv' not in src:
        raise SystemExit('build.gradle signing patch failed')
    return src


edit(os.path.join(A, 'build.gradle'), gradle)
print('Android project patched: version', version_name, '(', version_code, ')')
