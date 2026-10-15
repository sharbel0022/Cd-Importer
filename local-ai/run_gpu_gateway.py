"""Explicit opt-in GPU gateway, on a separate loopback port. No CPU fallback."""
import argparse
import os

from gpu_runtime import configure_cuda_dlls


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be 1024–65535')
    configure_cuda_dlls()
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('A real CUDA device is required; use the original CPU gateway separately.')
    # Discovery alone does not prove kernel compatibility with Blackwell.
    probe = torch.ones((32, 32), device='cuda')
    if (probe @ probe).sum().item() != 32768:
        raise RuntimeError('CUDA kernel smoke check failed')
    del probe
    torch.cuda.empty_cache()
    os.environ.update(WHISPER_DEVICE='cuda', WHISPER_COMPUTE_TYPE='float16', WHISPER_REQUIRE_GPU='true')
    import uvicorn
    uvicorn.run('server:app', host='127.0.0.1', port=args.port)


if __name__ == '__main__':
    main()
