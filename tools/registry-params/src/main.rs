//! Emit the CBOR parameters blob for an `ante-registry` instance.
//!
//! Usage: `registry-params [--purpose <str>] [--floor <bits>]`
//! Defaults: purpose `ante:identity-level:v1`, floor `12`.
//!
//! Output (stdout): two lines — `hex <hex>` and `bytes <json-array>`.

use ante_core::registry::RegistryParameters;

fn main() {
    let mut purpose = "ante:identity-level:v1".to_string();
    let mut floor: u32 = 12;

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
            other => bail(&format!("unknown argument: {other}")),
        }
    }

    let params = RegistryParameters {
        purpose,
        min_bits_floor: floor,
    };
    let mut cbor = Vec::new();
    ciborium::into_writer(&params, &mut cbor).expect("serialize");

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

fn bail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}
