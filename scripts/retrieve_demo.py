"""
Simple retrieval demo after running build_vector_store.py.
Usage: python scripts/retrieve_demo.py --query "reactor temperature high and feed flow unstable"
"""
import argparse, pickle
from pathlib import Path
from sentence_transformers import SentenceTransformer
import faiss
import numpy as np

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--query', required=True)
    ap.add_argument('--store', default='vector_store')
    ap.add_argument('--model', default='sentence-transformers/all-MiniLM-L6-v2')
    ap.add_argument('--k', type=int, default=5)
    args=ap.parse_args()
    store=Path(args.store)
    index=faiss.read_index(str(store/'faiss.index'))
    docs=pickle.load(open(store/'docs.pkl','rb'))
    model=SentenceTransformer(args.model)
    q=model.encode([args.query], normalize_embeddings=True)
    scores, ids=index.search(np.asarray(q,dtype='float32'), args.k)
    for score, idx in zip(scores[0], ids[0]):
        d=docs[idx]
        print('\n---')
        print('score:', round(float(score),4), '|', d['doc_id'], '|', d['doc_type'])
        print(d['title'])
        print(d['text'][:800])
if __name__=='__main__': main()
