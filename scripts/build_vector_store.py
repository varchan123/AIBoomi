"""
Build a local FAISS vector store from vector_documents.jsonl.
Requires: pip install sentence-transformers faiss-cpu
This script is optional. The dataset already includes embedding-ready chunks.
"""
import json, argparse, pickle
from pathlib import Path
from sentence_transformers import SentenceTransformer
import faiss
import numpy as np

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--docs', default='vector_documents.jsonl')
    ap.add_argument('--outdir', default='vector_store')
    ap.add_argument('--model', default='sentence-transformers/all-MiniLM-L6-v2')
    args=ap.parse_args()
    out=Path(args.outdir); out.mkdir(exist_ok=True)
    docs=[json.loads(l) for l in open(args.docs)]
    model=SentenceTransformer(args.model)
    texts=[d['text'] for d in docs]
    emb=model.encode(texts, normalize_embeddings=True, show_progress_bar=True)
    index=faiss.IndexFlatIP(emb.shape[1])
    index.add(np.asarray(emb, dtype='float32'))
    faiss.write_index(index, str(out/'faiss.index'))
    pickle.dump(docs, open(out/'docs.pkl','wb'))
    print(f'Built vector store with {len(docs)} documents')
if __name__=='__main__': main()
