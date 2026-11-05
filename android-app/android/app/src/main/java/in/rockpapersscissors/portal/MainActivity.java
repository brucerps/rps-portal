package in.rockpapersscissors.portal;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.concurrent.Executor;

/** The RPS portal, locked with fingerprint (or the phone's screen lock) every time it opens. */
public class MainActivity extends BridgeActivity {
    private static final long RELOCK_AFTER_MS = 60_000; // lock again after a minute in the background
    private boolean unlocked = false, prompting = false;
    private long leftAt = 0;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        hidePortal(true);
    }

    @Override public void onResume() {
        super.onResume();
        if (unlocked && leftAt > 0 && SystemClock.elapsedRealtime() - leftAt > RELOCK_AFTER_MS) unlocked = false;
        if (!unlocked) askToUnlock();
    }

    @Override public void onPause() { super.onPause(); leftAt = SystemClock.elapsedRealtime(); if (!unlocked) return; }

    @Override public void onStop() { super.onStop(); if (!isChangingConfigurations()) leftAt = SystemClock.elapsedRealtime(); }

    private void hidePortal(boolean hide) {
        View v = getBridge() != null ? getBridge().getWebView() : null;
        if (v != null) v.setVisibility(hide ? View.INVISIBLE : View.VISIBLE);
    }

    private int authenticators() {
        return Build.VERSION.SDK_INT >= 30
            ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            : BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    }

    private void askToUnlock() {
        if (prompting) return;
        hidePortal(true);
        int can = BiometricManager.from(this).canAuthenticate(authenticators());
        if (can != BiometricManager.BIOMETRIC_SUCCESS) {
            Toast.makeText(this, "Set up a fingerprint or screen lock on this phone to use the RPS app.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        prompting = true;
        Executor ex = ContextCompat.getMainExecutor(this);
        BiometricPrompt prompt = new BiometricPrompt(this, ex, new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult r) {
                prompting = false; unlocked = true; leftAt = 0; hidePortal(false); askForLocation();
            }
            @Override public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                prompting = false; finish(); // cancelled or failed: close the app
            }
        });
        BiometricPrompt.PromptInfo.Builder b = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Rock Papers Scissors")
            .setSubtitle("Use your fingerprint or screen lock");
        if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(authenticators());
        else b.setDeviceCredentialAllowed(true);
        prompt.authenticate(b.build());
    }

    private void askForLocation() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 7);
    }
}
