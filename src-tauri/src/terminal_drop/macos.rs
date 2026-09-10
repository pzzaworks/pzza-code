use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Method, Sel};
use objc2::{msg_send, sel};
use std::sync::OnceLock;

type Operation = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;
type Perform = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;
type Exit = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

struct Callbacks {
    entered: Operation,
    updated: Operation,
    perform: Perform,
    exited: Exit,
}
struct Hooks {
    class: &'static AnyClass,
    original: Callbacks,
    webkit: Callbacks,
}
static HOOKS: OnceLock<Hooks> = OnceLock::new();

#[link(name = "AppKit", kind = "framework")]
extern "C" {
    static NSFilenamesPboardType: *mut AnyObject;
    fn pthread_main_np() -> i32;
}

enum Route {
    Native,
    Html,
    Reject,
}

unsafe fn route(info: *mut AnyObject) -> Route {
    if info.is_null() {
        return Route::Reject;
    }
    // Only OS pasteboard metadata selects the file route. Malformed file lists
    // must not reach either the runtime's typed casts or WebKit navigation.
    let pasteboard: *mut AnyObject = msg_send![info, draggingPasteboard];
    let value: *mut AnyObject = msg_send![pasteboard, propertyListForType: NSFilenamesPboardType];
    if value.is_null() {
        return Route::Html;
    }
    let array = AnyClass::get(c"NSArray").expect("AppKit array class");
    let is_array: Bool = msg_send![value, isKindOfClass: array];
    if !is_array.as_bool() {
        return Route::Reject;
    }
    let count: usize = msg_send![value, count];
    if count == 0 {
        return Route::Html;
    }
    let string = AnyClass::get(c"NSString").expect("AppKit string class");
    for index in 0..count {
        let path: *mut AnyObject = msg_send![value, objectAtIndex: index];
        let is_string: Bool = msg_send![path, isKindOfClass: string];
        if !is_string.as_bool() {
            return Route::Reject;
        }
    }
    Route::Native
}

unsafe extern "C-unwind" fn entered(
    this: *mut AnyObject,
    selector: Sel,
    info: *mut AnyObject,
) -> usize {
    let hooks = HOOKS.get().expect("native drop hooks installed");
    match route(info) {
        Route::Native => (hooks.original.entered)(this, selector, info),
        Route::Html => (hooks.webkit.entered)(this, selector, info),
        Route::Reject => 0,
    }
}
unsafe extern "C-unwind" fn updated(
    this: *mut AnyObject,
    selector: Sel,
    info: *mut AnyObject,
) -> usize {
    let hooks = HOOKS.get().expect("native drop hooks installed");
    match route(info) {
        Route::Native => (hooks.original.updated)(this, selector, info),
        Route::Html => (hooks.webkit.updated)(this, selector, info),
        Route::Reject => 0,
    }
}
unsafe extern "C-unwind" fn perform(
    this: *mut AnyObject,
    selector: Sel,
    info: *mut AnyObject,
) -> Bool {
    let hooks = HOOKS.get().expect("native drop hooks installed");
    match route(info) {
        Route::Native => (hooks.original.perform)(this, selector, info),
        Route::Html => (hooks.webkit.perform)(this, selector, info),
        Route::Reject => Bool::NO,
    }
}
unsafe extern "C-unwind" fn exited(this: *mut AnyObject, selector: Sel, info: *mut AnyObject) {
    let hooks = HOOKS.get().expect("native drop hooks installed");
    match route(info) {
        Route::Native => (hooks.original.exited)(this, selector, info),
        Route::Html => (hooks.webkit.exited)(this, selector, info),
        Route::Reject => (),
    }
}

fn methods(class: &'static AnyClass, owned: bool) -> Result<[&'static Method; 4], String> {
    // instance_method also finds inherited methods. Never patch one of those:
    // that would replace Apple's WKWebView implementation, not the runtime's.
    let declared = class.instance_methods();
    let lookup = |selector| -> Result<&'static Method, String> {
        if owned && !declared.iter().any(|method| method.name() == selector) {
            return Err("Native drag method is not declared by the webview runtime.".into());
        }
        class
            .instance_method(selector)
            .ok_or("Native drag method is unavailable.".into())
    };
    class
        .verify_sel::<(*mut AnyObject,), usize>(sel!(draggingEntered:))
        .and_then(|_| class.verify_sel::<(*mut AnyObject,), usize>(sel!(draggingUpdated:)))
        .and_then(|_| class.verify_sel::<(*mut AnyObject,), Bool>(sel!(performDragOperation:)))
        .and_then(|_| class.verify_sel::<(*mut AnyObject,), ()>(sel!(draggingExited:)))
        .map_err(|_| "Unsupported native drag method signature.")?;
    Ok([
        lookup(sel!(draggingEntered:))?,
        lookup(sel!(draggingUpdated:))?,
        lookup(sel!(performDragOperation:))?,
        lookup(sel!(draggingExited:))?,
    ])
}

unsafe fn callbacks(methods: [&Method; 4]) -> Callbacks {
    // All four native signatures were checked before converting their IMPs.
    Callbacks {
        entered: std::mem::transmute::<Imp, Operation>(methods[0].implementation()),
        updated: std::mem::transmute::<Imp, Operation>(methods[1].implementation()),
        perform: std::mem::transmute::<Imp, Perform>(methods[2].implementation()),
        exited: std::mem::transmute::<Imp, Exit>(methods[3].implementation()),
    }
}

/// # Safety
/// `pointer` must be a live Objective-C webview supplied by the desktop runtime
/// and remain valid for this call. Installation is restricted to the main thread.
pub unsafe fn install(pointer: *mut std::ffi::c_void) -> Result<(), String> {
    if pthread_main_np() != 1 {
        return Err("Native file drops must be installed on the main thread.".into());
    }
    let view = pointer
        .cast::<AnyObject>()
        .as_ref()
        .ok_or("Native webview unavailable.")?;
    let webkit_class = AnyClass::get(c"WKWebView").ok_or("WebKit class unavailable.")?;
    let mut class = view.class();
    // The runtime's class name includes its Rust module and crate version. Walk
    // through KVO wrappers to its direct WKWebView subclass, not a guessed isa.
    while class.superclass() != Some(webkit_class) {
        class = class
            .superclass()
            .ok_or("Unsupported native webview class.")?;
    }
    if !class
        .name()
        .to_bytes()
        .starts_with(b"wry::wkwebview::class::wry_web_view::WryWebView")
    {
        return Err("Unsupported native webview runtime.".into());
    }
    if let Some(hooks) = HOOKS.get() {
        return if hooks.class == class {
            Ok(())
        } else {
            Err("Native webview runtime changed.".into())
        };
    }
    let original = methods(class, true)?;
    let webkit = methods(webkit_class, false)?;
    let hooks = Hooks {
        class,
        original: callbacks(original),
        webkit: callbacks(webkit),
    };
    HOOKS
        .set(hooks)
        .map_err(|_| "Native file drops already installed.")?;
    // Preserve the live object's isa and KVO class. Subclassing an existing
    // NSKVONotifying view makes -class return nil and AppKit's computed corner
    // radii assert in NSDP_getComputedPropertyValue. Patch only the four owned
    // runtime methods, once, on the main thread; no Apple class is modified.
    original[0].set_implementation(std::mem::transmute::<Operation, Imp>(entered));
    original[1].set_implementation(std::mem::transmute::<Operation, Imp>(updated));
    original[2].set_implementation(std::mem::transmute::<Perform, Imp>(perform));
    original[3].set_implementation(std::mem::transmute::<Exit, Imp>(exited));
    Ok(())
}

#[test]
fn inherited_methods_are_never_patch_targets() {
    let webkit = AnyClass::get(c"WKWebView").expect("WebKit linked by the desktop runtime");
    assert!(methods(webkit, false).is_ok());
    let subclass = objc2::runtime::ClassBuilder::new(c"PzzaDragOwnershipTest", webkit)
        .expect("unique test class")
        .register();
    assert!(methods(subclass, true).is_err());
}
