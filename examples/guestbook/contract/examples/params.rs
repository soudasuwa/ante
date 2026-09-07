//! Emit the CBOR `GuestbookParameters` blob for `fdev publish --parameters`.
//!
//!   cargo run --example params -- --purpose <str> --min-bits <n> --out <path>
//!
//! Without `--out`, prints the hex. `scripts/publish-guestbook.sh` calls this.

use ante_guestbook_contract::GuestbookParameters;

fn main() {
    let mut purpose = "ante-guestbook:post:v2".to_string();
    let mut min_bits: u32 = 16;
    let mut out: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--purpose" => {
                purpose = args
                    .next()
                    .unwrap_or_else(|| bail("--purpose needs a value"))
            }
            "--min-bits" => {
                min_bits = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| bail("--min-bits needs a number"))
            }
            "--out" => out = Some(args.next().unwrap_or_else(|| bail("--out needs a path"))),
            other => bail(&format!("unknown argument: {other}")),
        }
    }

    let mut cbor = Vec::new();
    ciborium::into_writer(&GuestbookParameters { purpose, min_bits }, &mut cbor)
        .expect("serialize");

    match out {
        Some(path) => {
            std::fs::write(&path, &cbor).unwrap_or_else(|e| bail(&format!("writing {path}: {e}")));
            println!("{path}");
        }
        None => println!(
            "{}",
            cbor.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ),
    }
}

fn bail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}
