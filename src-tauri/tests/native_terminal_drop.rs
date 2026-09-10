// Standalone main-thread runtime regression, not the application entry point.
// No sidecar, tmux, application plugins, persistent webview storage, or network.
// Run with cargo test --test native_terminal_drop on a macOS desktop.
#[cfg(target_os = "macos")]
#[path = "../src/terminal_drop/macos.rs"]
mod macos_drop;

#[cfg(target_os = "macos")]
mod native {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{msg_send, sel, Encode, Encoding};
    use std::ffi::CString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{DragDropEvent, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

    #[derive(Clone, Copy)]
    #[repr(C)]
    struct Point {
        x: f64,
        y: f64,
    }
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    unsafe fn string(text: &str) -> Retained<AnyObject> {
        let class = AnyClass::get(c"NSString").unwrap();
        let value = CString::new(text).unwrap();
        let object: *mut AnyObject = msg_send![class, alloc];
        let object: *mut AnyObject = msg_send![object, initWithUTF8String: value.as_ptr()];
        Retained::from_raw(object).unwrap()
    }
    unsafe extern "C-unwind" fn pasteboard(this: *mut AnyObject, _: Sel) -> *mut AnyObject {
        let this = &*this;
        *this
            .class()
            .instance_variable(c"pasteboard")
            .unwrap()
            .load(this)
    }
    unsafe extern "C-unwind" fn window(this: *mut AnyObject, _: Sel) -> *mut AnyObject {
        let this = &*this;
        *this
            .class()
            .instance_variable(c"window")
            .unwrap()
            .load(this)
    }
    extern "C-unwind" fn location(_: *mut AnyObject, _: Sel) -> Point {
        Point { x: 120.0, y: 200.0 }
    }
    extern "C-unwind" fn source(_: *mut AnyObject, _: Sel) -> *mut AnyObject {
        std::ptr::null_mut()
    }
    extern "C-unwind" fn operation(_: *mut AnyObject, _: Sel) -> usize {
        1
    }
    extern "C-unwind" fn sequence(_: *mut AnyObject, _: Sel) -> isize {
        42
    }
    extern "C-unwind" fn zero(_: *mut AnyObject, _: Sel) -> isize {
        0
    }
    extern "C-unwind" fn reset(_: *mut AnyObject, _: Sel) {}
    unsafe extern "C-unwind" fn integer(this: *mut AnyObject, selector: Sel) -> isize {
        let this = &*this;
        let name = if selector == sel!(draggingFormation) {
            c"formation"
        } else {
            c"validItems"
        };
        *this.class().instance_variable(name).unwrap().load(this)
    }
    unsafe extern "C-unwind" fn set_integer(this: *mut AnyObject, selector: Sel, value: isize) {
        let this = &*this;
        let name = if selector == sel!(setDraggingFormation:) {
            c"formation"
        } else {
            c"validItems"
        };
        *this
            .class()
            .instance_variable(name)
            .unwrap()
            .load_ptr::<isize>(this) = value;
    }
    unsafe extern "C-unwind" fn animates(this: *mut AnyObject, _: Sel) -> Bool {
        let this = &*this;
        *this
            .class()
            .instance_variable(c"animates")
            .unwrap()
            .load(this)
    }
    unsafe extern "C-unwind" fn set_animates(this: *mut AnyObject, _: Sel, value: Bool) {
        let this = &*this;
        *this
            .class()
            .instance_variable(c"animates")
            .unwrap()
            .load_ptr::<Bool>(this) = value;
    }
    // This metadata-driven drag has no preview images. Content still comes
    // from the real pasteboard and is dispatched by the real WebKit process.
    extern "C-unwind" fn enumerate_images(
        _: *mut AnyObject,
        _: Sel,
        _: usize,
        _: *mut AnyObject,
        _: *mut AnyObject,
        _: *mut AnyObject,
        _: *mut AnyObject,
    ) {
    }
    unsafe extern "C-unwind" fn unrecognized(this: *mut AnyObject, _: Sel, missing: Sel) {
        eprintln!(
            "Missing test drag protocol method: {}",
            missing.name().to_string_lossy()
        );
        let _: () = msg_send![super(this, AnyClass::get(c"NSObject").unwrap()), doesNotRecognizeSelector: missing];
    }

    // Test-supplied NSDraggingInfo backed by a real, uniquely named OS
    // pasteboard, sent to the real runtime and WKWebView implementations.
    // It never reads or modifies the user's general clipboard.
    struct Drag {
        info: Retained<AnyObject>,
        board: Retained<AnyObject>,
    }
    impl Drag {
        unsafe fn new(destination: *mut AnyObject, file: Option<&std::path::Path>) -> Self {
            static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
            let class = CLASS.get_or_init(|| {
                let mut builder = ClassBuilder::new(c"PzzaNativeDragRegressionInfo", AnyClass::get(c"NSObject").unwrap()).unwrap();
                builder.add_method(sel!(doesNotRecognizeSelector:), unrecognized as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, Sel));
                builder.add_ivar::<*mut AnyObject>(c"pasteboard");
                builder.add_ivar::<*mut AnyObject>(c"window");
                builder.add_ivar::<isize>(c"formation");
                builder.add_ivar::<isize>(c"validItems");
                builder.add_ivar::<Bool>(c"animates");
                builder.add_method(sel!(draggingFormation), integer as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> isize);
                builder.add_method(sel!(setDraggingFormation:), set_integer as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, isize));
                builder.add_method(sel!(springLoadingHighlight), zero as extern "C-unwind" fn(*mut AnyObject, Sel) -> isize);
                builder.add_method(sel!(resetSpringLoading), reset as extern "C-unwind" fn(*mut AnyObject, Sel));
                builder.add_method(sel!(setAnimatesToDestination:), set_animates as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, Bool));
                builder.add_method(sel!(draggingPasteboard), pasteboard as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject);
                builder.add_method(sel!(draggingDestinationWindow), window as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject);
                builder.add_method(sel!(draggingLocation), location as extern "C-unwind" fn(*mut AnyObject, Sel) -> Point);
                builder.add_method(sel!(draggingSource), source as extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject);
                builder.add_method(sel!(draggingSourceOperationMask), operation as extern "C-unwind" fn(*mut AnyObject, Sel) -> usize);
                builder.add_method(sel!(draggingSequenceNumber), sequence as extern "C-unwind" fn(*mut AnyObject, Sel) -> isize);
                builder.add_method(sel!(animatesToDestination), animates as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool);
                builder.add_method(sel!(enumerateDraggingItemsWithOptions:forView:classes:searchOptions:usingBlock:), enumerate_images as extern "C-unwind" fn(*mut AnyObject, Sel, usize, *mut AnyObject, *mut AnyObject, *mut AnyObject, *mut AnyObject));
                builder.add_method(sel!(numberOfValidItemsForDrop), integer as unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> isize);
                builder.add_method(sel!(setNumberOfValidItemsForDrop:), set_integer as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, isize));
                builder.register()
            });
            let pb: *mut AnyObject = msg_send![
                AnyClass::get(c"NSPasteboard").unwrap(),
                pasteboardWithUniqueName
            ];
            let board = Retained::retain(pb).unwrap();
            let kind = string(if file.is_some() {
                "NSFilenamesPboardType"
            } else {
                "public.utf8-plain-text"
            });
            let types: *mut AnyObject =
                msg_send![AnyClass::get(c"NSArray").unwrap(), arrayWithObject: &*kind];
            let _: isize =
                msg_send![pb, declareTypes: types, owner: std::ptr::null_mut::<AnyObject>()];
            let value = string(
                file.map(|path| path.to_str().unwrap())
                    .unwrap_or("HTML drag routing"),
            );
            let written: Bool = if file.is_some() {
                let paths: *mut AnyObject =
                    msg_send![AnyClass::get(c"NSArray").unwrap(), arrayWithObject: &*value];
                msg_send![pb, setPropertyList: paths, forType: &*kind]
            } else {
                msg_send![pb, setString: &*value, forType: &*kind]
            };
            assert!(written.as_bool());
            let object: *mut AnyObject = msg_send![*class, new];
            let info = Retained::from_raw(object).unwrap();
            *class
                .instance_variable(c"pasteboard")
                .unwrap()
                .load_ptr::<*mut AnyObject>(&info) = pb;
            *class
                .instance_variable(c"window")
                .unwrap()
                .load_ptr::<*mut AnyObject>(&info) = destination;
            *class
                .instance_variable(c"validItems")
                .unwrap()
                .load_ptr::<isize>(&info) = 1;
            Self { info, board }
        }
        fn pointer(&self) -> usize {
            (&*self.info as *const AnyObject) as usize
        }
    }
    impl Drop for Drag {
        fn drop(&mut self) {
            unsafe {
                let _: () = msg_send![&*self.board, releaseGlobally];
            }
        }
    }

    pub fn run() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("pzza-native-drop-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("real ' dropped file.txt");
        std::fs::write(&file, b"native drop regression").unwrap();
        let reports = Arc::new(Mutex::new(Vec::new()));
        let file_events = Arc::new(Mutex::new(Vec::new()));
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = "dev.pzzacode.native-drop-regression".into();
        context.config_mut().product_name = Some("Native drop regression".into());
        context.config_mut().app.windows.clear();
        let setup_reports = reports.clone();
        let setup_events = file_events.clone();
        let app = tauri::Builder::default()
            .plugin(tauri::plugin::Builder::<tauri::Wry>::new("native-drop-regression")
                .on_webview_ready(|webview| {
                    webview.with_webview(|native| unsafe {
                        let view = &*native.inner().cast::<AnyObject>();
                        let before = view.class();
                        let declared_before: *const AnyClass = msg_send![view, class];
                        assert!(!declared_before.is_null());
                        let webkit = AnyClass::get(c"WKWebView").unwrap();
                        let selectors = [sel!(draggingEntered:), sel!(draggingUpdated:), sel!(performDragOperation:), sel!(draggingExited:)];
                        let apple_imps: Vec<_> = selectors.iter().map(|s| webkit.instance_method(*s).unwrap().implementation() as usize).collect();
                        for _ in 0..2 { super::macos_drop::install(native.inner()).expect("install native file drop routing"); }
                        let declared_after: *const AnyClass = msg_send![view, class];
                        assert_eq!(before, view.class(), "KVO/isa must not change");
                        assert_eq!(declared_before, declared_after, "public class must remain valid");
                        for (index, selector) in selectors.iter().enumerate() {
                            assert_eq!(apple_imps[index], webkit.instance_method(*selector).unwrap().implementation() as usize, "Apple method was modified");
                        }
                        // Invoke the exact WebKit layout callback and AppKit
                        // property getter from the original startup SIGABRT.
                        if view.class().instance_method(sel!(_viewDidChangeEffectiveCornerRadii)).is_some() {
                            let _: () = msg_send![view, _viewDidChangeEffectiveCornerRadii];
                            let _: *mut AnyObject = msg_send![view, _effectiveCornerRadii];
                            println!("KVO class preserved; real corner-radius callback/getter passed.");
                        }
                        let html = string("<!doctype html><html><body>Native drag test</body></html>");
                        let _: *mut AnyObject = msg_send![view, loadHTMLString: &*html, baseURL: std::ptr::null_mut::<AnyObject>()];
                    }).unwrap();
                }).build())
            .setup(move |app| {
                for label in ["first", "second"] {
                    let observations = setup_reports.clone();
                    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External("about:blank".parse().unwrap()))
                        .title("Native file-drop regression")
                        .inner_size(600.0, 400.0)
                        .visible(true).focused(false).incognito(true)
                        .on_navigation(move |url| {
                            if url.host_str() == Some("native-drop-regression.invalid") {
                                observations.lock().unwrap().push(format!("{label}{}", url.path()));
                                return false;
                            }
                            url.as_str() == "about:blank"
                        })
                        .initialization_script("document.addEventListener('DOMContentLoaded', () => { document.body.innerHTML = '<div draggable=true>Drag source</div><div style=\"height:300px\">Drop target</div>'; document.addEventListener('dragenter', e => { e.preventDefault(); location.href = 'https://native-drop-regression.invalid/html-enter'; }); document.addEventListener('dragover', e => e.preventDefault()); document.addEventListener('drop', e => { e.preventDefault(); location.href = 'https://native-drop-regression.invalid/html-drop'; }); location.href = 'https://native-drop-regression.invalid/loaded'; });")
                        .build()?;
                    let events = setup_events.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::DragDrop(event) = event { events.lock().unwrap().push(event.clone()); }
                    });
                }
                Ok(())
            })
            .build(context).expect("build isolated native webviews");
        let finished = Arc::new(AtomicBool::new(false));
        let clock_finished = finished.clone();
        let handle = app.handle().clone();
        let ticker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            while !clock_finished.load(Ordering::Acquire) {
                if Instant::now() >= deadline {
                    handle.exit(1);
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
                if handle.run_on_main_thread(|| {}).is_err() {
                    break;
                }
            }
        });
        let completed = finished.clone();
        let mut phase = 0;
        let mut drags = Vec::new();
        let result = app.run_return(move |app, event| {
            if matches!(event, RunEvent::Exit) && phase != 4 {
                eprintln!("Native test ended in phase {phase}; page reports {:?}; native events {:?}", reports.lock().unwrap(), file_events.lock().unwrap());
            }
            if !matches!(event, RunEvent::MainEventsCleared) { return; }
            let first = app.get_webview_window("first").unwrap();
            match phase {
                0 if reports.lock().unwrap().iter().filter(|r| r.ends_with("/loaded")).count() == 2 => {
                    let native_window = first.ns_window().unwrap().cast::<AnyObject>();
                    drags.push(unsafe { Drag::new(native_window, Some(&file)) });
                    drags.push(unsafe { Drag::new(native_window, None) });
                    let info = drags[0].pointer();
                    first.with_webview(move |native| unsafe {
                        let view = native.inner().cast::<AnyObject>();
                        let info = info as *mut AnyObject;
                        let entered: usize = msg_send![view, draggingEntered: info];
                        let updated: usize = msg_send![view, draggingUpdated: info];
                        let performed: Bool = msg_send![view, performDragOperation: info];
                        let _: () = msg_send![view, draggingExited: info];
                        assert_eq!(entered, 1); assert_eq!(updated, 1); assert!(performed.as_bool());
                    }).unwrap();
                    phase = 1;
                }
                1 if file_events.lock().unwrap().len() >= 4 => {
                    let events = file_events.lock().unwrap();
                    assert_eq!(events.len(), 4);
                    for event in events.iter() {
                        match event {
                            DragDropEvent::Enter { paths, position } | DragDropEvent::Drop { paths, position } => {
                                assert_eq!(paths, &[file.clone()]);
                                assert_eq!((position.x, position.y), (120.0, 200.0), "native coordinates are logical even on Retina");
                            }
                            DragDropEvent::Over { position } => assert_eq!((position.x, position.y), (120.0, 200.0)),
                            DragDropEvent::Leave => (),
                            _ => panic!("unexpected native drag event"),
                        }
                    }
                    println!("Real native file callbacks passed at scale {}.", first.scale_factor().unwrap());
                    drop(events);
                    let info = drags[1].pointer();
                    first.with_webview(move |native| unsafe {
                        let _: usize = msg_send![native.inner().cast::<AnyObject>(), draggingEntered: info as *mut AnyObject];
                    }).unwrap();
                    phase = 2;
                }
                2 if reports.lock().unwrap().iter().any(|r| r.ends_with("/html-enter")) => {
                    let info = drags[1].pointer();
                    first.with_webview(move |native| unsafe {
                        let view = native.inner().cast::<AnyObject>();
                        let info = info as *mut AnyObject;
                        let _: usize = msg_send![view, draggingUpdated: info];
                        let _: Bool = msg_send![view, performDragOperation: info];
                    }).unwrap();
                    phase = 3;
                }
                3 if reports.lock().unwrap().iter().any(|r| r.ends_with("/html-drop")) => {
                    assert_eq!(file_events.lock().unwrap().len(), 4, "HTML drags must not be swallowed by native file events");
                    println!("Real WebKit dragenter/drop reached the HTML document without native file events.");
                    let info = drags[1].pointer();
                    first.with_webview(move |native| unsafe {
                        let view = native.inner().cast::<AnyObject>();
                        let _: () = msg_send![view, draggingExited: info as *mut AnyObject];
                        println!("HTML exit sender passed.");
                        let _: () = msg_send![view, draggingExited: std::ptr::null_mut::<AnyObject>()];
                        println!("Absent exit sender passed.");
                    }).unwrap();
                    completed.store(true, Ordering::Release);
                    app.exit(0);
                    phase = 4;
                }
                _ => (),
            }
        });
        let passed = finished.swap(true, Ordering::AcqRel);
        ticker.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(result, 0, "native drag regression timed out");
        assert!(
            passed,
            "native regression exited before completing all phases"
        );
        println!("Native startup, repeated installation, two nonpersistent views, file/HTML routing and cleanup passed.");
    }
}

#[cfg(target_os = "macos")]
fn main() {
    native::run();
}
#[cfg(not(target_os = "macos"))]
fn main() {
    println!("Native file-drop runtime regression requires macOS.");
}
