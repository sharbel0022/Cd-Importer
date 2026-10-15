"""Process-local CUDA DLL discovery. Never changes the CPU venv or system PATH."""
import os
import sys
from pathlib import Path

_dll_handles = []


def configure_cuda_dlls():
    if os.name != 'nt':
        return []
    directory = Path(sys.prefix) / 'Lib' / 'site-packages' / 'torch' / 'lib'
    if not directory.is_dir():
        raise RuntimeError('CUDA runtime absent: install the GPU requirements in the isolated venv.')
    # CTranslate2 loads cuBLAS/cuDNN by name. Keep add_dll_directory handles
    # alive, and set PATH only for this process and its children.
    _dll_handles.append(os.add_dll_directory(str(directory)))
    os.environ['PATH'] = str(directory) + os.pathsep + os.environ.get('PATH', '')
    return [str(directory)]
