FROM public.ecr.aws/docker/library/python:3.10.12-slim

RUN pip install -U pip

WORKDIR /usr/src/app

COPY requirements.txt requirements.txt

RUN pip install -r requirements.txt

COPY . .

ENTRYPOINT [ "/usr/local/bin/python", "-m", "awslambdaric" ]
