//! Emit the CBOR parameters blob for an `ante-registry` instance.
//!
//! Usage: `registry-params [--purpose <str>] [--floor <bits>] [--out <path>]`
//! Defaults: purpose `ante:identity-level:v1`, floor `12`.
//!
//! Without `--out`: prints `hex <hex>` and `bytes <json-array>` to stdout.
//! With `--out <path>`: writes the raw CBOR bytes to that file (what
//! `fdev publish --parameters` wants) and prints the path.

use std::io::Write;

use ante_core::registry::RegistryParameters;

fn main() {
    let mut purpose = "ante:identity-level:v1".to_string();
    let mut floor: u32 = 12;
    let mut out: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--purpose" => {
                purpose = args
                    .next()
                    .unwrap_or_else(|| bail("--purpose needs a value"))
            }
            "--floor" => {
                floor = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| bail("--floor needs a number"))
            }
            "--out" => out = Some(args.next().unwrap_or_else(|| bail("--out needs a path"))),
            other => bail(&format!("unknown argument: {other}")),
        }
    }

    let params = RegistryParameters {
        purpose,
        min_bits_floor: floor,
    };
    let mut cbor = Vec::new();
    ciborium::into_writer(&params, &mut cbor).expect("serialize");

    match out {
        Some(path) => {
            std::fs::File::create(&path)
                .and_then(|mut f| f.write_all(&cbor))
                .unwrap_or_else(|e| bail(&format!("writing {path}: {e}")));
            println!("{path}");
        }
        None => {
            println!(
                "hex {}",
                cbor.iter().map(|b| format!("{b:02x}")).collect::<String>()
            );
            println!(
                "bytes [{}]",
                cbor.iter()
                    .map(|b| b.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
    }
}

fn bail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}
