# Методы моста вызываются из JavaScript по имени — R8 не должен их переименовывать или удалять.
-keepattributes JavascriptInterface
-keepclassmembers class dev.tainik.android.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
